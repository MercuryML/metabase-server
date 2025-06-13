import axios from 'axios';

const METABASE_SESSION_ID = process.env.METABASE_SESSION_ID;
const METABASE_URL = process.env.METABASE_URL;

async function get_field_id_test() {
  try {
    const table_name = "enterprise_scorecard_metrics_summary";
    const field_name = "state_code";
    const response = await axios.get(`${METABASE_URL}/api/search`, {
      headers: {
          'X-Metabase-Session': METABASE_SESSION_ID
        },
      params: {
        q: table_name,
        type: "table",
      }
    });
    interface MetabaseTableSearchResult {
      id: number;
      name: string;
      table_name: string;
      database_id: number;
    }

    const table: MetabaseTableSearchResult = response.data.data.find(
      (r: MetabaseTableSearchResult) => r.table_name === table_name
    );
            
    const TABLE_ID = table.id;
            
    const table_metadata = await axios.get(
      `${METABASE_URL}/api/table/${TABLE_ID}/query_metadata`,
      {
        headers: {
          'X-Metabase-Session': METABASE_SESSION_ID
        },
      }
    );
    const field = table_metadata.data.fields.find((f: any) => f.name === field_name);
    console.log(`Field id for "${field_name}" is "${field.id}"`);

  } catch (err) {
    console.error(err);
  }
}

get_field_id_test();
