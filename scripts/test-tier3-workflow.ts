import 'dotenv/config';
import { mastra } from '../src/mastra';
import { getDbClient, initializeDatabase } from '../src/mastra/db/schema';

async function getLatestTier2Run() {
  await initializeDatabase();
  const client = await getDbClient();

  // Get the latest screening run with Tier 2 results
  const runsResult = await client.execute(`
    SELECT * FROM screening_runs
    WHERE tier2_output_count > 0
    ORDER BY started_at DESC
    LIMIT 1
  `);

  if (runsResult.rows.length === 0) {
    throw new Error('No Tier 2 screening runs found. Run tier2-triage-workflow first.');
  }

  const run = runsResult.rows[0] as any;

  // Get the finalists that passed Tier 2
  const finalistsResult = await client.execute({
    sql: `
      SELECT
        ticker,
        tier1_score,
        tier2_decision,
        tier2_quick_checks
      FROM stock_analyses
      WHERE screening_run_id = ? AND tier2_passed = 1
      ORDER BY tier1_score DESC
    `,
    args: [run.id],
  });

  return {
    runId: run.id as string,
    strategy: run.strategy as 'value' | 'growth' | 'balanced',
    tier2OutputCount: run.tier2_output_count as number,
    finalists: finalistsResult.rows.map((r: any) => {
      const quickChecks = r.tier2_quick_checks ? JSON.parse(r.tier2_quick_checks) : {};
      return {
        ticker: r.ticker,
        companyName: r.ticker, // Will be populated by workflow
        sector: quickChecks.sector || null,
        tier1Score: r.tier1_score,
        price: quickChecks.currentPrice || 0,
        marketCap: 0,
        metrics: {},
        componentScores: {},
        triageDecision: r.tier2_decision as 'PASS' | 'FAST_TRACK',
        triageReasoning: quickChecks.reasoning || '',
        redFlags: quickChecks.redFlags || [],
        greenFlags: quickChecks.greenFlags || [],
        analystConsensus: quickChecks.analystConsensus || null,
        targetUpside: quickChecks.targetUpside || null,
        shortRisk: quickChecks.shortRisk || null,
        earningsSentiment: quickChecks.earningsSentiment || null,
        beta: quickChecks.beta || null,
      };
    }),
  };
}

async function testTier3Workflow() {
  console.log('=== Testing Tier 3 Deep Research Workflow ===\n');

  // Get the latest Tier 2 results
  console.log('Fetching latest Tier 2 results...');
  const tier2Data = await getLatestTier2Run();

  console.log(`Found screening run: ${tier2Data.runId}`);
  console.log(`Strategy: ${tier2Data.strategy}`);
  console.log(`Tier 2 finalists: ${tier2Data.finalists.length}`);

  // For testing, limit to first 5 candidates (deep analysis is expensive)
  const testFinalists = tier2Data.finalists.slice(0, 5);
  console.log(`\nTesting with ${testFinalists.length} finalists:`);
  testFinalists.forEach((f, i) => {
    const decision = f.triageDecision === 'FAST_TRACK' ? '⚡' : '✓';
    console.log(`  ${i + 1}. ${f.ticker} (Score: ${f.tier1Score}) ${decision}`);
  });

  // Build Tier 2 output format for Tier 3 input
  const tier2Output = {
    screeningRunId: tier2Data.runId,
    finalists: testFinalists,
    finalistCount: testFinalists.length,
    rejectedCount: 0,
    fastTrackedCount: testFinalists.filter((f) => f.triageDecision === 'FAST_TRACK').length,
    executionTimeSeconds: 0,
    strategy: tier2Data.strategy,
    config: {
      maxHoldings: 5, // Limit for testing
      minConviction: 40, // Lower threshold for testing
      maxPositionWeight: 15,
      runDCF: true,
      runComparables: true,
      runSentiment: true,
      runRisk: true,
      runEarnings: true,
    },
  };

  console.log('\n--- Starting Tier 3 Deep Research ---');
  console.log('WARNING: This will run 5 analysis workflows per stock.');
  console.log('Expected time: 5-10 minutes for 5 stocks.\n');

  try {
    const workflow = mastra.getWorkflow('tier3ResearchWorkflow');
    const run = await workflow.createRunAsync();

    const startTime = Date.now();
    const result = await run.start({ inputData: tier2Output });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\nWorkflow completed in ${elapsed}s`);

    if (result.status === 'success') {
      const output = result.result as any;

      console.log('\n=== TIER 3 RESULTS ===');
      console.log(`Strategy: ${output.strategy}`);
      console.log(`Portfolio Holdings: ${output.portfolioCount}`);
      console.log(`Rejected: ${output.rejectedCount}`);
      console.log(`Average Conviction: ${output.averageConviction}/100`);
      console.log(`Average Upside: ${output.averageUpside !== null ? output.averageUpside + '%' : 'N/A'}`);
      console.log(`Total Weight: ${output.totalWeight.toFixed(1)}%`);

      console.log('\n--- FINAL PORTFOLIO ---');
      output.portfolio.forEach((h: any, i: number) => {
        const upside =
          h.compositeUpside !== null ? `${h.compositeUpside > 0 ? '+' : ''}${h.compositeUpside.toFixed(1)}%` : 'N/A';
        console.log(`\n${i + 1}. ${h.ticker}`);
        console.log(`   Conviction: ${h.convictionLevel} (${h.convictionScore}/100)`);
        console.log(`   Weight: ${h.suggestedWeight.toFixed(1)}%`);
        console.log(`   Upside: ${upside}`);
        console.log(`   Bull: ${h.bullFactors.slice(0, 2).join('; ') || 'None'}`);
        console.log(`   Bear: ${h.bearFactors.slice(0, 2).join('; ') || 'None'}`);
      });

      if (output.rejected.length > 0) {
        console.log('\n--- REJECTED FROM PORTFOLIO ---');
        output.rejected.forEach((r: any, i: number) => {
          console.log(`${i + 1}. ${r.ticker} - ${r.reason}`);
        });
      }
    } else {
      console.log('Workflow failed:', result.status);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error('Error running workflow:', error);
  }
}

testTier3Workflow();
