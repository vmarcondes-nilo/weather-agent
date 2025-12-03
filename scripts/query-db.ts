import 'dotenv/config';
import { getDbClient, initializeDatabase } from '../src/mastra/db/schema';

async function queryDb() {
  await initializeDatabase();
  const client = await getDbClient();

  console.log('=== Screening Runs ===');
  const runsResult = await client.execute('SELECT * FROM screening_runs ORDER BY started_at DESC LIMIT 3');
  const runs = runsResult.rows;
  console.log('Recent screening runs:');
  runs.forEach((r: any, i: number) => {
    console.log(`\n${i + 1}. ${r.id}`);
    console.log(`   Type: ${r.run_type} | Strategy: ${r.strategy} | Status: ${r.status}`);
    console.log(`   Universe: ${r.universe_count} | Tier 1 Passed: ${r.tier1_output_count}`);
    console.log(`   Started: ${r.started_at}`);
  });

  console.log('\n\n=== Stock Analyses (latest run) ===');
  const latestRun = runs[0] as any;
  if (latestRun) {
    const analysesResult = await client.execute({
      sql: `
        SELECT ticker, tier1_score, tier1_passed
        FROM stock_analyses
        WHERE screening_run_id = ?
        ORDER BY tier1_score DESC
      `,
      args: [latestRun.id]
    });
    const analyses = analysesResult.rows;

    console.log(`\nStocks from run: ${String(latestRun.id).slice(0, 30)}...`);
    console.log('-'.repeat(60));
    analyses.forEach((a: any) => {
      console.log(`${String(a.ticker).padEnd(6)} | Score: ${String(a.tier1_score).padStart(3)} | Passed: ${a.tier1_passed ? 'Yes' : 'No'}`);
    });
  }
}

queryDb().catch(console.error);
