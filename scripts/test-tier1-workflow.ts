import 'dotenv/config';
import { mastra } from '../src/mastra';

async function testTier1Workflow() {
  console.log('=== Testing Tier 1 Screening Workflow ===\n');

  // Use a small sample of diverse stocks for testing
  const testUniverse = [
    'AAPL',  // Tech - Large Cap
    'MSFT',  // Tech - Large Cap
    'JPM',   // Financials
    'JNJ',   // Healthcare
    'XOM',   // Energy
    'PG',    // Consumer Staples
    'HD',    // Consumer Discretionary
    'UNH',   // Healthcare
    'V',     // Financials
    'MA',    // Financials
  ];

  const input = {
    universe: testUniverse,
    strategy: 'balanced' as const,
    config: {
      targetCount: 5,  // Select top 5 from 10
      minScore: 40,    // Minimum score threshold
      factorWeights: {
        value: 0.25,
        quality: 0.25,
        risk: 0.20,
        growth: 0.15,
        momentum: 0.15,
      },
    },
  };

  console.log('Input configuration:');
  console.log(`- Universe: ${testUniverse.length} stocks`);
  console.log(`- Strategy: ${input.strategy}`);
  console.log(`- Target count: ${input.config.targetCount}`);
  console.log(`- Min score: ${input.config.minScore}`);
  console.log('\n');

  try {
    const workflow = mastra.getWorkflow('tier1ScreeningWorkflow');
    const run = await workflow.createRunAsync();

    console.log('Starting workflow run...\n');
    const startTime = Date.now();

    const result = await run.start({ inputData: input });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\nWorkflow completed in ${elapsed}s`);
    console.log('\n=== Results ===\n');

    if (result.status === 'success') {
      const output = result.result as any;
      console.log(`Screening Run ID: ${output.screeningRunId}`);
      console.log(`Total Screened: ${output.totalScreened}`);
      console.log(`Candidates Passing: ${output.passedCount}`);
      console.log(`Rejected: ${output.rejectedCount}`);
      console.log('\nTop Candidates:');

      for (const candidate of output.candidates.slice(0, 5)) {
        console.log(`\n  ${candidate.ticker} (${candidate.companyName}):`);
        console.log(`    Tier 1 Score: ${candidate.tier1Score}`);
        console.log(`    Sector: ${candidate.sector || 'N/A'}`);
        console.log(`    Price: $${candidate.price?.toFixed(2) || 'N/A'}`);
        console.log(`    Component Scores:`);
        console.log(`      - Value: ${candidate.componentScores?.valueScore || 'N/A'}`);
        console.log(`      - Quality: ${candidate.componentScores?.qualityScore || 'N/A'}`);
        console.log(`      - Risk: ${candidate.componentScores?.riskScore || 'N/A'}`);
        console.log(`      - Growth: ${candidate.componentScores?.growthScore || 'N/A'}`);
        console.log(`      - Momentum: ${candidate.componentScores?.momentumScore || 'N/A'}`);
      }
    } else {
      console.log('Workflow failed:', result.status);
      console.log('Error:', JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error('Error running workflow:', error);
  }
}

testTier1Workflow();
