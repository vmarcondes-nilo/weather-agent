import 'dotenv/config';
import { mastra } from '../src/mastra';
import { getDbClient, initializeDatabase } from '../src/mastra/db/schema';

async function getLatestTier1Run() {
  await initializeDatabase();
  const client = await getDbClient();

  // Get the latest screening run with Tier 1 results
  const runsResult = await client.execute(`
    SELECT * FROM screening_runs
    WHERE tier1_output_count > 0
    ORDER BY started_at DESC
    LIMIT 1
  `);

  if (runsResult.rows.length === 0) {
    throw new Error('No Tier 1 screening runs found. Run tier1-screening-workflow first.');
  }

  const run = runsResult.rows[0] as any;

  // Get the candidates that passed Tier 1
  const candidatesResult = await client.execute({
    sql: `
      SELECT
        ticker,
        tier1_score
      FROM stock_analyses
      WHERE screening_run_id = ? AND tier1_passed = 1
      ORDER BY tier1_score DESC
    `,
    args: [run.id],
  });

  return {
    runId: run.id as string,
    strategy: run.strategy as 'value' | 'growth' | 'balanced',
    tier1OutputCount: run.tier1_output_count as number,
    candidates: candidatesResult.rows.map((r: any) => ({
      ticker: r.ticker,
      tier1Score: r.tier1_score,
    })),
  };
}

async function testTier2Workflow() {
  console.log('=== Testing Tier 2 Triage Workflow ===\n');

  // Get the latest Tier 1 results
  console.log('Fetching latest Tier 1 results...');
  const tier1Data = await getLatestTier1Run();

  console.log(`Found screening run: ${tier1Data.runId}`);
  console.log(`Strategy: ${tier1Data.strategy}`);
  console.log(`Tier 1 candidates: ${tier1Data.candidates.length}`);

  // For testing, limit to first 15 candidates
  const testCandidates = tier1Data.candidates.slice(0, 15);
  console.log(`\nTesting with ${testCandidates.length} candidates:`);
  testCandidates.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.ticker} (Score: ${c.tier1Score})`);
  });

  // Build mock Tier 1 output format
  const tier1Output = {
    screeningRunId: tier1Data.runId,
    candidates: testCandidates.map((c) => ({
      ticker: c.ticker,
      companyName: c.ticker, // Will be enriched by triage
      sector: null,
      tier1Score: c.tier1Score,
      price: 0,
      marketCap: 0,
      metrics: {},
      componentScores: {},
    })),
    totalScreened: tier1Data.tier1OutputCount,
    passedCount: testCandidates.length,
    rejectedCount: tier1Data.tier1OutputCount - testCandidates.length,
    rejectionBreakdown: {},
    executionTimeSeconds: 0,
    strategy: tier1Data.strategy,
    config: {
      maxFinalists: 10, // Limit to 10 for testing
    },
  };

  console.log('\n--- Starting Tier 2 Triage ---\n');

  try {
    const workflow = mastra.getWorkflow('tier2TriageWorkflow');
    const run = await workflow.createRunAsync();

    const startTime = Date.now();
    const result = await run.start({ inputData: tier1Output });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\nWorkflow completed in ${elapsed}s`);

    if (result.status === 'success') {
      const output = result.result as any;

      console.log('\n=== TIER 2 RESULTS ===');
      console.log(`Finalists: ${output.finalistCount}`);
      console.log(`Rejected: ${output.rejectedCount}`);
      console.log(`Fast-tracked: ${output.fastTrackedCount}`);

      console.log('\n--- Finalists ---');
      output.finalists.slice(0, 10).forEach((f: any, i: number) => {
        const icon = f.triageDecision === 'FAST_TRACK' ? '⚡' : '✓';
        console.log(`\n${i + 1}. ${f.ticker} ${icon} ${f.triageDecision}`);
        console.log(`   Score: ${f.tier1Score}`);
        console.log(`   Analyst: ${f.analystConsensus || 'N/A'} | Target Upside: ${f.targetUpside?.toFixed(1) || 'N/A'}%`);
        console.log(`   Beta: ${f.beta?.toFixed(2) || 'N/A'} | Short Risk: ${f.shortRisk || 'N/A'}`);
        console.log(`   Green Flags: ${f.greenFlags.length > 0 ? f.greenFlags.join(', ') : 'None'}`);
        console.log(`   Red Flags: ${f.redFlags.length > 0 ? f.redFlags.join(', ') : 'None'}`);
      });

      if (output.rejected.length > 0) {
        console.log('\n--- Rejected ---');
        output.rejected.slice(0, 5).forEach((r: any, i: number) => {
          console.log(`${i + 1}. ${r.ticker} - ${r.reason}`);
        });
        if (output.rejected.length > 5) {
          console.log(`   ... and ${output.rejected.length - 5} more`);
        }
      }
    } else {
      console.log('Workflow failed:', result.status);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error('Error running workflow:', error);
  }
}

testTier2Workflow();
