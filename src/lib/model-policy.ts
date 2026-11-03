// PRD R-PRV-01: the model provider policy checked at start-up. Pure function.
import type { DeploymentConfig } from '../config/load.ts'

type ModelConfig = NonNullable<DeploymentConfig['model']>

// UK and EEA regions need no transfer basis; any other region (or none stated) for an external provider does
const UK_EEA = /^(uk|gb|eu|eea|europe)\b|^(at|be|bg|hr|cy|cz|dk|ee|fi|fr|de|gr|hu|ie|it|lv|lt|lu|mt|nl|pl|pt|ro|sk|si|es|se|is|li|no)\b/i

// a host that is on this machine or this network: loopback, private ranges, link-local, a single-label service name
// (`ollama` in Docker Compose) or mDNS `.local`
function looksLocal(url: string): boolean {
  let h: string
  try {
    h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || !h.includes('.') && !h.includes(':')) return true
  if (/^(127|10)\.\d+\.\d+\.\d+$/.test(h) || /^192\.168\.\d+\.\d+$/.test(h) || /^169\.254\.\d+\.\d+$/.test(h)) return true
  const m = /^172\.(\d+)\.\d+\.\d+$/.exec(h)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  return /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:')
}

/** R-PRV-01: `refuse` stops start-up; `warnings` go to the start-up log and the banner at the top of the review UI. */
export function modelPolicy(m: ModelConfig): { refuse: string | null; warnings: string[] } {
  const warnings: string[] = []
  // a hosted provider is external whatever the configuration says (configuration load also rejects the mismatch)
  if (m.location === 'local' && m.provider !== 'anthropic') {
    // the location is the deployer's declaration; a host that looks external is said out loud (S4), not refused
    if (m.provider === 'ollama' && m.ollama_host && !looksLocal(m.ollama_host)) warnings.push(`model provider ollama is declared local but its host ${new URL(m.ollama_host).hostname} does not look local (loopback, private network or a service name)`)
    return { refuse: null, warnings }
  }
  if (!m.dpa) {
    if (!m.allow_without_dpa) return { refuse: `external model provider ${m.provider} without a data processing agreement (dpa: true, or allow_without_dpa: true)`, warnings }
    warnings.push(`external model provider ${m.provider} runs without a data processing agreement (allow_without_dpa)`)
  }
  if (!(m.region && UK_EEA.test(m.region)) && !m.transfer_basis) warnings.push(`model provider region ${m.region ?? 'not stated'} is outside the UK / EEA and no transfer basis is recorded`)
  if (!m.no_training) warnings.push(`model provider ${m.provider}: no_training is not confirmed`)
  return { refuse: null, warnings }
}
