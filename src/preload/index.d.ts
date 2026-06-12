import type { TeslaApi } from '../shared/types'

declare global {
  interface Window {
    teslaApi: TeslaApi
  }
}

export {}
