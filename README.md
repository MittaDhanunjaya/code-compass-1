# Code Compass (AIForge)

A web-based AI coding editor with Chat, Composer, and Agent modes. Bring your own LLM keys (OpenRouter, OpenAI, Gemini, Perplexity).

## GitHub integration (short pitch)

My app can log into your GitHub, work directly on your repo on a separate branch, and—with your consent each time—commit, push, and open PRs for you, very similar to how Perplexity's GitHub connector works.

## Getting started

See `.env.local.example` for required environment variables. Run `npm install` and `npm run dev`.

**Hosted deployment:** To run Code Compass as a single URL where users sign up and add API keys (no self-hosting), see [docs/HOSTED_DEPLOYMENT.md](docs/HOSTED_DEPLOYMENT.md).

**One-click deploy:** [Deploy with Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyour-org%2Fcode-compass-1) — after cloning, add Supabase env vars (see [HOSTED_DEPLOYMENT](docs/HOSTED_DEPLOYMENT.md)); deploy is typically under 10 minutes.
