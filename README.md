# Custom Automation Tools (Copilot Agent)

A powerful, agentic AI automation platform built with the **GitHub Copilot SDK**. This toolset transforms a Telegram Bot into an intelligent assistant capable of performing complex tasks by dispatching user requests to specialized "Agents".

## 🚀 Features

- **Intelligent Intent Analysis**: Uses GitHub Copilot to analyze natural language messages and route them to the appropriate specialized agent.
- **Telegram Integration**: Seamless interaction via a Telegram Bot.
- **Agentic Architecture**: Modular "Skills" system allows for easy expansion of capabilities.
- **Task Tracking**: Prevents duplicate execution of long-running tasks.

### 🤖 Specialized Agents

1. **SDD Agent (`SDD_AGENT`)**
   - Generates comprehensive **Software Design Documents (SDD)**.
   - Intelligently selects relevant project rules and documentation folders to read.
   - Produces Markdown-formatted SDDs saved to the `output/` directory.

2. **Stock Agent (`STOCK_AGENT`)**
   - _Logic for stock market analysis and queries._

3. **Todo Agent (`TODO_AGENT`)**
   - Simple task management to record and save todo items.

## 🛠 Prerequisites

- **Node.js** (v18 or higher recommended)
- **TypeScript**
- **Telegram Bot Token** (from @BotFather)
- **GitHub Copilot Access**

## 📦 Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/Jett-Xu/Custom_Automation_Tools.git
   cd Custom_Automation_Tools
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## ⚙️ Configuration

Create a `.env` file in the root directory with the following variables:

```env
TELEGRAM_TOKEN=your_telegram_bot_token
PORT=3000
# Add other necessary environment variables
```

## ▶️ Usage

### Development Mode

Run the bot locally with hot-reloading:

```bash
npm run dev
```

### Production Build

Compile the TypeScript code and run:

```bash
npm run build
node dist/index.js
```

## 📂 Project Structure

```
src/
├── agents/           # Specialized agent implementations (SDD, Stock, Todo)
├── config/           # Configuration files
├── platforms/        # Platform adapters (e.g., Telegram)
├── services/         # Core services (Providers, Storage, TaskTracker)
├── types/            # TypeScript type definitions
└── index.ts          # Application entry point and orchestrator
```

## 🔧 Adding a New Agent

1. Create a new folder in `src/agents/`.
2. Implement the agent logic following the `SkillFunction` type.
3. Register the new agent in `src/agents/index.ts`.
4. Ensure the Intent Analyzer can recognize the new capability.

## 📄 License

ISC
