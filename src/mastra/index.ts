import 'dotenv/config';
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { weatherWorkflow } from './workflows';
import { equityAnalysisWorkflow } from './workflows/equity-workflow';
import { dcfValuationWorkflow, comparableAnalysisWorkflow } from './workflows/valuation-workflows';
import { sentimentAnalysisWorkflow } from './workflows/sentiment-workflow';
import { riskAssessmentWorkflow } from './workflows/risk-workflow';
import { fullResearchWorkflow } from './workflows/full-research-workflow';
import { weatherAgent } from './agents';
import { analystAgent } from './agents/analyst-agent';
import { fundamentalAnalyst } from './agents/fundamental-analyst';
import { sentimentAnalyst } from './agents/sentiment-analyst';
import { riskAnalyst } from './agents/risk-analyst';
import { masterAnalyst } from './agents/master-analyst';

export const mastra = new Mastra({
  workflows: {
    weatherWorkflow,
    equityAnalysisWorkflow,
    dcfValuationWorkflow,
    comparableAnalysisWorkflow,
    sentimentAnalysisWorkflow,
    riskAssessmentWorkflow,
    fullResearchWorkflow,
  },
  agents: {
    weatherAgent,
    analystAgent,
    fundamentalAnalyst,
    sentimentAnalyst,
    riskAnalyst,
    masterAnalyst,
  },
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  storage: new LibSQLStore({
    url: 'file:mastra-memory.db',
  }),
});
