import 'dotenv/config';
import { mastra } from '../src/mastra';

async function testIntelligentPortfolioBuilder() {
  console.log('=== Testing Intelligent Portfolio Builder ===\n');
  console.log('This is a quick test run with limited scope.');
  console.log('For full run, remove testMode and sample limits.\n');

  try {
    const workflow = mastra.getWorkflow('intelligentPortfolioWorkflow');
    const run = await workflow.createRunAsync();

    const startTime = Date.now();

    // Run with test configuration for faster execution
    const result = await run.start({
      inputData: {
        strategy: 'balanced',
        config: {
          // Portfolio settings
          portfolioId: 'ipb-test-portfolio',
          portfolioName: 'IPB Test Portfolio',
          initialCapital: 100000,
          targetHoldings: 5, // Limit for testing
          cashReservePct: 5,
          maxSectorPct: 30,
          maxPositionPct: 25,
          minPositionPct: 5,

          // Tier settings
          tier1MinScore: 50,
          tier1MaxCandidates: 20, // Limit for testing
          tier2MaxFinalists: 10, // Limit for testing
          tier3MinConviction: 40,

          // Test mode - reduces analysis depth
          testMode: true,
        },
      },
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\nWorkflow completed in ${elapsed}s`);

    if (result.status === 'success') {
      const output = result.result as any;

      if (output.success) {
        console.log('\n=== SUCCESS ===\n');
        console.log(`Screening Run: ${output.screeningRunId}`);
        console.log(`Portfolio: ${output.portfolioId}`);
        console.log(`Strategy: ${output.strategy}`);

        console.log('\n--- PIPELINE SUMMARY ---');
        console.log(`Tier 1: ${output.pipeline.tier1.inputCount} → ${output.pipeline.tier1.outputCount} (${output.pipeline.tier1.executionTimeSeconds}s)`);
        console.log(`Tier 2: ${output.pipeline.tier2.inputCount} → ${output.pipeline.tier2.outputCount} (${output.pipeline.tier2.executionTimeSeconds}s)`);
        console.log(`Tier 3: ${output.pipeline.tier3.inputCount} → ${output.pipeline.tier3.outputCount} (${output.pipeline.tier3.executionTimeSeconds}s)`);
        console.log(`Total: ${output.pipeline.totalExecutionTimeSeconds}s`);

        console.log('\n--- PORTFOLIO ---');
        console.log(`Holdings: ${output.portfolio.holdingsCount}`);
        console.log(`Total Value: $${output.portfolio.totalValue.toLocaleString()}`);
        console.log(`Cash: $${output.portfolio.cashValue.toLocaleString()}`);
        console.log(`Avg Conviction: ${output.portfolio.averageConviction}/100`);
        console.log(`Avg Upside: ${output.portfolio.averageUpside ? output.portfolio.averageUpside + '%' : 'N/A'}`);

        console.log('\n--- HOLDINGS ---');
        output.holdings.forEach((h: any, i: number) => {
          const upside = h.compositeUpside !== null
            ? `${h.compositeUpside > 0 ? '+' : ''}${h.compositeUpside.toFixed(1)}%`
            : 'N/A';
          console.log(`${i + 1}. ${h.ticker.padEnd(6)} | ${h.weight.toFixed(1)}% | ${h.convictionLevel.padEnd(9)} (${h.convictionScore}) | Upside: ${upside}`);
        });

        console.log('\n--- SECTOR BREAKDOWN ---');
        Object.entries(output.portfolio.sectorBreakdown).forEach(([sector, data]: [string, any]) => {
          console.log(`  ${sector}: ${data.count} stocks, ${data.weight.toFixed(1)}% (${data.tickers.join(', ')})`);
        });
      } else {
        console.log('\n=== FAILED ===');
        console.log(`Error: ${output.errorMessage}`);
      }
    } else {
      console.log('\nWorkflow execution failed:', result.status);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error('Error running workflow:', error);
  }
}

// Run the test
testIntelligentPortfolioBuilder();
