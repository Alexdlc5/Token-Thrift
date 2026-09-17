// Side-effect imports: each provider adapter calls registerProvider() at module load.

import './openrouter'
import './groq'
import './google-ai-studio'
import './cerebras'
import './nvidia-nim'
import './huggingface'
import './mistral'
import './cloudflare-workers-ai'

export { getProvider, listProviders } from './registry'
