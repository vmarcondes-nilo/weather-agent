# Multi-Agent AI System

This project demonstrates how to build AI-powered agents using the Mastra framework. It includes two specialized agents: a Weather Agent and an Equity Research Analyst.

## Overview

This template showcases how to:

- Create multiple AI-powered agents using Mastra framework
- Implement multi-step workflows for complex tasks
- Handle user queries with specialized tools
- Manage conversation memory and context
- Integrate with external APIs for real-time data
- Coordinate agents, tools, and workflows

## Agents

### 1. Weather Agent
Provides weather information and activity recommendations for any location.

**Capabilities:**
- Current weather conditions (temperature, humidity, wind speed)
- Activity recommendations based on weather
- Multi-day itinerary planning
- Location-specific suggestions

**Tools:**
- `weatherTool` - Fetches current weather data
- `planActivitiesTool` - Generates activity recommendations

**Workflows:**
- `weatherWorkflow` - Complete weather + activity planning pipeline

### 2. Equity Research Analyst
Professional equity research agent for analyzing public stocks.

**Capabilities:**
- Real-time stock prices and market data
- Financial metrics analysis (P/E, EPS, margins, growth rates)
- Company news and sentiment monitoring
- Comprehensive investment analysis
- Multi-stock comparison

**Tools:**
- `getStockPriceTool` - Current price, volume, 52-week range, market cap
- `getFinancialsTool` - Key financial ratios and metrics
- `getCompanyNewsTool` - Recent news articles and press releases

**Workflows:**
- `equityAnalysisWorkflow` - Complete fundamental analysis pipeline

## Setup

1. Copy `.env.example` to `.env` and fill in your API keys.
2. Install dependencies: `pnpm install`
3. Run the project: `pnpm dev`
4. Access Mastra Studio at `http://localhost:4111`

## Environment Variables

- `OPENAI_API_KEY`: Your OpenAI API key. [Get one here](https://platform.openai.com/api-keys)

## Project Structure

```
src/mastra/
├── agents/
│   ├── index.ts              # Weather Agent
│   └── analyst-agent.ts      # Equity Research Analyst
├── tools/
│   ├── index.ts              # Weather tools
│   └── equity-tools.ts       # Stock market tools
├── workflows/
│   ├── index.ts              # Weather workflow
│   └── equity-workflow.ts    # Equity analysis workflow
└── index.ts                  # Main Mastra configuration
```

## Example Usage

### Weather Agent
```
User: "What's the weather in Orlando?"
Agent: Uses weatherTool → Provides current conditions

User: "What should I do there today?"
Agent: Uses planActivitiesTool → Suggests activities based on weather
```

### Equity Research Analyst
```
User: "Analyze AAPL"
Agent: Runs equityAnalysisWorkflow → Comprehensive analysis

User: "What's the current price of MSFT?"
Agent: Uses getStockPriceTool → Returns real-time price data

User: "Get financial metrics for GOOGL"
Agent: Uses getFinancialsTool → Returns P/E, margins, growth rates
```

## Features

- **Multi-Agent System**: Multiple specialized agents working together
- **Tool Integration**: External API calls for real-time data
- **Workflows**: Multi-step processes for complex analyses
- **Memory**: Conversation history and user preferences
- **Streaming**: Real-time response generation
- **Type Safety**: Full TypeScript with Zod validation

## Technologies

- **Framework**: [Mastra](https://mastra.ai)
- **Language**: TypeScript
- **AI Model**: OpenAI GPT-4o
- **Data APIs**: Open-Meteo (weather), Yahoo Finance (stocks)
- **Storage**: LibSQL (SQLite)
- **Logging**: Pino
