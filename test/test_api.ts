import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';

const METABASE_SESSION_ID = process.env.METABASE_SESSION_ID;
const METABASE_URL = process.env.METABASE_URL;
const DATABASE_ID = 2; // clickhouse database id

// Generic function to call Metabase API
async function callMetabaseApi<T>(
  endpoint: string,
  method: 'GET' | 'POST',
  data?: any,
  params?: any,
  customHeaders?: Record<string, string>
): Promise<T> {
  const headers = {
    'Content-Type': 'application/json',
    'X-Metabase-Session': METABASE_SESSION_ID,
    ...customHeaders,
  };

  const config: AxiosRequestConfig = {
    url: `${METABASE_URL}${endpoint}`,
    method,
    headers,
    data,
    params,
  };

  const response = await axios.request<T>(config);
  return response.data;
}

// Create a card (example usage of POST)
async function createCard(query: string, name = 'test12345') {
  const data = {
    name,
    dataset_query: {
      type: 'native',
      native: { query },
      database: DATABASE_ID,
    },
    visualization_settings: {},
    display: 'table',
  };
  console.log(JSON.stringify(data));
  // If you need to use a different session for this, pass customHeaders
  return callMetabaseApi(
    '/api/card',
    'POST',
    data,
  );
}

// Get table id by table name
async function getTableId(table_name: string): Promise<number | undefined> {
  const data = await callMetabaseApi<any>(
    '/api/search',
    'GET',
    undefined,
    { q: table_name, type: 'table' }
  );
  const table = data.data.find(
    (r: any) => r.table_name === table_name && r.database_id === DATABASE_ID
  );
  return table?.id;
}

// Get field id by field name and table id
async function getFieldId(table_id: number, field_name: string): Promise<number | undefined> {
  const data = await callMetabaseApi<any>(
    `/api/table/${table_id}/query_metadata`,
    'GET'
  );
  const field = data.fields.find((f: any) => f.name === field_name);
  return field?.id;
}

// Main test function
async function tool_test() {
  try {
    const table_name = "v_ad_claims_all_metrics_obt_by_exposure_monthly_main";
    const field_name = "dimension_type";

    // Example: create a card
    const card = await createCard(
      'SELECT * FROM  v_ad_claims_all_metrics_obt_by_exposure_monthly_main limit 10'
    );
    console.log('Card creation response:', JSON.stringify(card, null, 2));

    // Get table id
    const table_id = await getTableId(table_name);
    if (!table_id) throw new Error(`Table "${table_name}" not found`);
    console.log(`Table id for "${table_name}" is "${table_id}"`);

    // Get field id
    const field_id = await getFieldId(table_id, field_name);
    if (!field_id) throw new Error(`Field "${field_name}" not found`);
    console.log(`Field id for "${field_name}" is "${field_id}"`);

  } catch (err) {
    console.error(err);
  }
}

tool_test();
