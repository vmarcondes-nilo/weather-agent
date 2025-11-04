import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { weatherWorkflow } from './workflows';
import { equityAnalysisWorkflow } from './workflows/equity-workflow';
import { weatherAgent } from './agents';
import { analystAgent } from './agents/analyst-agent';

export const mastra = new Mastra({
  workflows: { 
    weatherWorkflow,
    equityAnalysisWorkflow,
  },
  agents: { 
    weatherAgent,
    analystAgent,
  },
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  storage: new LibSQLStore({
    url: 'file:mastra-memory.db',
  }),
});
