// «Meld feil eller forbedring» — lager en ticket i ikn-tickets på repoet
// borge-ikn/faktureringsrapport. Port av ordreapp-v2/netlify/functions/meld-inn.js,
// men uten @supabase/supabase-js: denne siten har ingen package.json, og
// sync-budsjett.mjs bruker rå fetch mot Supabase på samme måte.
//
// Brukeren kan ikke skrive til `tickets` selv (RLS krever ticket_can_create og
// innmelder-rett på repoet, som står på 'lukket'). Derfor verifiserer funksjonen
// JWT-et og setter inn med service-nøkkelen. created_by kommer ALLTID fra det
// verifiserte JWT-et, aldri fra kroppen — ellers kunne en innlogget bruker
// meldt inn i en kollegas navn.

import { randomUUID } from 'node:crypto';

const SUPABASE_URL = 'https://eeikodpeeybrzgxcsflh.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// borge-ikn/faktureringsrapport i ikn-tickets (repos.id). Hardkodet med vilje:
// funksjonen finnes bare for denne appen, og en env-variabel som kan peke feil
// ville bare gitt tickets i et tilfeldig repo.
const REPO_ID = '908d2dd2-126f-47bd-8ad8-68ca3de6a8c0';
const BUCKET = 'ticket-attachments';

// Ansvarlig for repoet i ikn-tickets — mottar varselet om ny innmelding.
const VARSEL_TIL = 'bkv@industrikran.no';

// Netlify tåler 6 MB kropp, og base64 blåser opp med en tredjedel. Bildet
// komprimeres i nettleseren, så taket treffes i praksis aldri.
const MAKS_VEDLEGG = 4 * 1024 * 1024;

// tickets_category_check tillater flere, men skjemaet har to knapper.
const KATEGORIER = ['bug', 'improvement'];

const json = (status, data) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const restHeaders = (extra = {}) => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

async function hentBruker(req) {
  const auth = req.headers.get('authorization') || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!jwt) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) return null;
  const bruker = await res.json();
  return bruker?.id ? bruker : null;
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!SERVICE_KEY) return json(500, { error: 'SUPABASE_SERVICE_ROLE_KEY ikke satt' });

  const bruker = await hentBruker(req);
  if (!bruker) return json(401, { error: 'Krever innlogging' });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Ugyldig JSON' });
  }

  const kategori = String(body.kategori || '');
  const tittel = String(body.tittel || '').trim();
  const beskrivelse = String(body.beskrivelse || '').trim();

  if (!KATEGORIER.includes(kategori)) return json(400, { error: 'kategori må være bug eller improvement' });
  if (!tittel) return json(400, { error: 'Mangler tittel' });

  // created_by har FK mot profiles. Rollen settes IKKE her: en innmelding skal
  // ikke gi rettigheter i ticket-appen. ignore-duplicates: en eksisterende rad
  // kan ha fått rettigheter eller display_name satt manuelt i ikn-tickets.
  const meta = bruker.user_metadata || {};
  const profilRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?on_conflict=id`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify({
      id: bruker.id,
      epost: bruker.email || null,
      display_name: meta.full_name || meta.name || bruker.email || null,
    }),
  });
  if (!profilRes.ok) {
    console.error('[meld-inn] kunne ikke sikre profiles-rad:', profilRes.status, await profilRes.text());
    return json(500, { error: 'Kunne ikke registrere deg som innmelder' });
  }

  // ticket_number utelates med vilje — triggeren tickets_sett_nummer deler ut
  // neste nummer.
  const ticketRes = await fetch(`${SUPABASE_URL}/rest/v1/tickets?select=id,ticket_number`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({
      title: tittel.slice(0, 200),
      description: byggBeskrivelse(beskrivelse, body.metadata, bruker.email),
      category: kategori,
      status: 'new',
      priority: 'normal',
      project: 'faktureringsrapport',
      repo_id: REPO_ID,
      created_by: bruker.id,
    }),
  });
  if (!ticketRes.ok) {
    console.error('[meld-inn] insert i tickets feilet:', ticketRes.status, await ticketRes.text());
    return json(500, { error: 'Kunne ikke opprette innmeldingen' });
  }
  const ticket = (await ticketRes.json())?.[0];
  if (!ticket) return json(500, { error: 'Kunne ikke opprette innmeldingen' });

  // Feiler vedlegget, beholdes ticketen. Brukeren som får «kunne ikke sende»
  // etter at ticketen er opprettet melder inn på nytt, og da står det to like.
  let vedleggFeilet = false;
  if (body.vedlegg_base64 && body.vedlegg_filnavn) {
    vedleggFeilet = !(await lastOppVedlegg(ticket.id, bruker.id, body));
  }

  await varsleAnsvarlig(ticket, tittel, bruker.email);

  return json(200, { id: ticket.id, ticket_number: ticket.ticket_number, vedlegg_feilet: vedleggFeilet });
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// Metadata legges i beskrivelsen framfor egne kolonner: tickets har ingen
// felter for visning/enhet, og en ny kolonne ville tvunget en endring i
// ikn-tickets for å bli synlig. Som tekst leses det i eksisterende UI.
function byggBeskrivelse(beskrivelse, metadata, epost) {
  const m = metadata && typeof metadata === 'object' ? metadata : {};
  const linjer = [
    ['Meldt inn fra', 'faktureringsrapport'],
    ['Bruker', epost || 'ukjent'],
    ['Visning', m.visning],
    ['Måned', m.maaned],
    ['Avdeling', m.avdeling],
    ['Enhet', m.enhet],
    ['Skjermbredde', m.skjerm],
  ].filter(([, v]) => v).map(([k, v]) => `- ${k}: ${String(v).slice(0, 300)}`);

  const tekst = beskrivelse ? beskrivelse.slice(0, 8000) : '_Ingen beskrivelse oppgitt._';
  return `${tekst}\n\n---\n${linjer.join('\n')}`;
}

// Returnerer true ved suksess. Feilen logges, ticketen står uansett.
async function lastOppVedlegg(ticketId, brukerId, body) {
  try {
    const innhold = Buffer.from(String(body.vedlegg_base64), 'base64');
    if (!innhold.length) return false;
    if (innhold.length > MAKS_VEDLEGG) {
      console.error(`[meld-inn] vedlegg for stort: ${innhold.length} bytes`);
      return false;
    }

    // Stien genereres SERVERSIDE og følger mønsteret ikn-tickets alt bruker:
    // <ticket-id>/<uuid>.<ext>. Klientens filnavn brukes bare til filendelsen.
    const endelse = (String(body.vedlegg_filnavn).match(/\.([a-zA-Z0-9]{1,8})$/)?.[1] || 'bin').toLowerCase();
    const sti = `${ticketId}/${randomUUID()}.${endelse}`;
    const mime = String(body.vedlegg_mime || 'application/octet-stream').slice(0, 100);

    const oppRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${sti}`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': mime, 'x-upsert': 'false' },
      body: innhold,
    });
    if (!oppRes.ok) {
      console.error('[meld-inn] opplasting til storage feilet:', oppRes.status, await oppRes.text());
      return false;
    }

    const radRes = await fetch(`${SUPABASE_URL}/rest/v1/ticket_attachments`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ ticket_id: ticketId, uploaded_by: brukerId, path: sti, mime }),
    });
    if (!radRes.ok) {
      console.error('[meld-inn] rad i ticket_attachments feilet:', radRes.status, await radRes.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('[meld-inn] uventet feil i vedleggsopplasting:', e);
    return false;
  }
}

// Samme Make-relay som ordreapp-v2. Feiler e-posten står ticketen likevel, men
// det logges — aldri stille.
async function varsleAnsvarlig(ticket, tittel, innmelder) {
  const relay = process.env.MAKE_EMAIL_RELAY_URL;
  if (!relay) {
    console.error('[meld-inn] MAKE_EMAIL_RELAY_URL ikke satt — ingen varsling sendt');
    return;
  }
  const lenke = `https://ikn-tickets.netlify.app/ticket/${ticket.id}`;
  const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: #002554; padding: 20px 24px;">
    <span style="color: #f1b434; font-size: 20px; font-weight: bold;">Industrikran Norge</span>
  </div>
  <div style="padding: 24px; background: #ffffff;">
    <p><strong>${esc(innmelder || 'En ansatt')}</strong> har meldt inn en sak fra faktureringsrapport.</p>
    <p style="background:#f4f5f7;border-left:4px solid #002554;padding:12px 16px;margin:16px 0;">
      <strong>#${ticket.ticket_number} – ${esc(tittel)}</strong>
    </p>
    <p style="margin-top: 24px;">
      <a href="${lenke}" style="background:#f1b434;color:#002554;font-weight:bold;padding:12px 22px;border-radius:8px;text-decoration:none;display:inline-block;">Åpne ticketen</a>
    </p>
  </div>
  <div style="background: #eeeeee; padding: 12px 24px; font-size: 12px; color: #666;">
    Dette er en automatisk melding fra faktureringsrapport.
  </div>
</div>`;

  try {
    const res = await fetch(relay, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: VARSEL_TIL,
        subject: `Ny innmelding #${ticket.ticket_number} fra faktureringsrapport: ${tittel}`,
        body_html: html,
      }),
    });
    if (!res.ok) console.error(`[meld-inn] varsling feilet: relay svarte ${res.status}`);
  } catch (e) {
    console.error('[meld-inn] varsling feilet:', e);
  }
}
