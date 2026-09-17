// Side-effect imports: each provider adapter calls registerProvider() at module load.

import './openrouter'
import './groq'
import './google-ai-studio'
import './cerebras'
import './nvidia-nim'
import './huggingface'

export { getProvider, listProviders } from './registry'
