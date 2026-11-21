import { create } from 'zustand'
import type { ChatModel, GatewayProtocol } from './api/types.js'
import { setModel, useSettings } from './settings.js'

export type ModelCapabilities = {
  reasoning: boolean
  search: boolean
  files: boolean
  vision: boolean
  voice: boolean
}

export type AvailableModel = { id: ChatModel; capabilities: ModelCapabilities }
type ModelState = {
  models: AvailableModel[]
  protocol: GatewayProtocol
  loading: boolean
  error: string
}

export const useModelCatalog = create<ModelState>(() => ({
  models: [],
  protocol: 'anthropic-messages',
  loading: true,
  error: '',
}))

export const loadModels = async () => {
  useModelCatalog.setState({ loading: true, error: '' })
  try {
    const response = await fetch('/api/models', { credentials: 'same-origin' })
    const result = await response.json()
    if (!response.ok) {
      throw new Error(result.error || 'Unable to load models')
    }
    const models = (result.models ?? []) as AvailableModel[]
    const protocol = (result.protocol ?? 'anthropic-messages') as GatewayProtocol
    useModelCatalog.setState({ models, protocol, loading: false, error: '' })
    const selected = useSettings.getState().model
    if (models.length && !models.some((model) => model.id === selected)) {
      setModel(models[0].id)
    }
    return models
  } catch (error) {
    useModelCatalog.setState({
      models: [],
      protocol: 'anthropic-messages',
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
