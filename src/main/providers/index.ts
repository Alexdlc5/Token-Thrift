// Side-effect imports: each provider adapter calls registerProvider() at module load.
// Add one line per provider here when wiring it in — don't touch the adapter files
// themselves to do it.
//
// import './openrouter'
// import './groq'

export { getProvider, listProviders } from './registry'
