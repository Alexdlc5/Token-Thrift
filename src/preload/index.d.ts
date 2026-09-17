import type { TokenThriftApi } from '@shared/api'

declare global {
  interface Window {
    api: TokenThriftApi
  }
}
