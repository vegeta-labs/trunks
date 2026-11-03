// The configured model adapter; the start-up policy of PRD R-PRV-01 is in src/lib/model-policy.ts.
import type { DeploymentConfig } from '../../config/load.ts'
import { AnthropicAdapter } from './anthropic.ts'
import { OllamaAdapter } from './ollama.ts'
import { ReplayAdapter } from './replay.ts'
import type { LlmAdapter } from './types.ts'

export { modelPolicy } from '../../lib/model-policy.ts'

type ModelConfig = NonNullable<DeploymentConfig['model']>

export function llmFromConfig(m: ModelConfig, env: NodeJS.ProcessEnv = process.env): LlmAdapter {
  switch (m.provider) {
    case 'anthropic': {
      const apiKey = env[m.api_key_env]
      return new AnthropicAdapter({ model: m.model_id, ...(apiKey ? { apiKey } : {}) })
    }
    case 'ollama':
      if (!m.ollama_host) throw new Error('model.ollama_host is required for the ollama provider')
      return new OllamaAdapter({ host: m.ollama_host, model: m.model_id })
    case 'replay':
      if (!m.replay_dir) throw new Error('model.replay_dir is required for the replay provider')
      return new ReplayAdapter(m.replay_dir, m.model_id)
  }
}
