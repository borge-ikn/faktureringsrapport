export const config = {
  schedule: "0 2 * * *",
};

const SUPABASE_URL = 'https://eeikodpeeybrzgxcsflh.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PO_CLIENT_ID = process.env.PO_CLIENT_ID;
const PO_CLIENT_SECRET = process.env.PO_CLIENT_SECRET;
const PO_SUBSCRIPTION_KEY = process.env.PO_SUBSCRIPTION_KEY;

async function getPoToken() {
  const credentials = Buffer.from(`${PO_CLIENT_ID}:${PO_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const res = await fetch("https://goapi.poweroffice.net/OAuth/Token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
      "Ocp-Apim-Subscription-Key": PO_SUBSCRIPTION_KEY,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PO auth feilet (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function fetchPoBudgets(token, year) {
  const res = await fetch(
    `https://goapi.poweroffice.net/v2/Budget?years=${year}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Ocp-Apim-Subscription-Key": PO_SUBSCRIPTION_KEY,
      },
    }
  );
  if (res.status === 204) return [];
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PO Budget henting feilet (${res.status}): ${text}`);
  }
  return res.json();
}

async function fetchAvdelingMap() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/po_avdelinger?select=code,name&is_active=eq.true`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  if (!res.ok) throw new Error(`Supabase avdelinger feilet: ${res.status}`);
  const rows = await res.json();
  return Object.fromEntries(rows.map((r) => [r.code, r.name]));
}

async function upsertBudgets(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/budgets?on_conflict=department_name,month`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert feilet: ${text}`);
  }
}

export default async () => {
  const year = new Date().getFullYear();

  console.log('Steg 1: Henter avdelinger fra Supabase...');
  const avdelingMap = await fetchAvdelingMap();
  console.log(`Avdelinger lastet: ${Object.keys(avdelingMap).length} stk`);

  console.log('Steg 2: Henter OAuth-token fra PowerOffice...');
  const token = await getPoToken();
  console.log('Token OK');

  console.log(`Steg 3: Henter budsjetter fra PO for år ${year}...`);
  const budgets = await fetchPoBudgets(token, year);
  console.log(`Hentet ${budgets.length} budsjetter fra PO for år ${year}`);

  const rows = [];
  const now = new Date().toISOString();

  for (const budget of budgets) {
    const linjer = budget.BudgetLineItems || [];

    const match = budget.Name?.match(/^(\d+)_/);
    if (!match) {
      console.warn(`Ukjent budsjettformat (hopper over): ${budget.Name}`);
      continue;
    }
    const kode = match[1];
    const avdelingNavn = avdelingMap[kode];
    if (!avdelingNavn) {
      console.warn(`Ingen avdeling for kode ${kode} (budsjett: ${budget.Name})`);
      continue;
    }

    const perMonth = {};
    for (const item of linjer) {
      if (item.Amount < 0 && item.Year === year) {
        const m = item.Month;
        perMonth[m] = (perMonth[m] || 0) + Math.abs(item.Amount);
      }
    }

    for (const [month, budsjett] of Object.entries(perMonth)) {
      rows.push({
        department_name: avdelingNavn,
        month: `${year}-${String(month).padStart(2, "0")}-01`,
        budsjett: Math.round(budsjett),
        updated_by: "po-sync",
        updated_at: now,
      });
    }
  }

  if (rows.length > 0) {
    await upsertBudgets(rows);
  }

  const msg = `Synkronisert ${rows.length} budsjettlinjer for år ${year}`;
  console.log(msg);
  return new Response(msg, { status: 200 });
};
