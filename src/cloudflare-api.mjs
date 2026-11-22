export async function cloudflareRequest(apiToken, method, path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.success !== true) {
    const message =
      payload?.errors?.map((error) => error.message).filter(Boolean).join('; ') ||
      `Cloudflare API returned HTTP ${response.status}`
    throw new Error(message)
  }
  return payload.result
}

export async function discoverCloudflare(apiToken) {
  const accounts = await cloudflareRequest(apiToken, 'GET', '/accounts?per_page=50')
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('No Cloudflare account is accessible by this API token.')
  }
  return accounts
}

export async function findZone(apiToken, accountId, hostname) {
  const zones = await cloudflareRequest(
    apiToken,
    'GET',
    `/zones?account.id=${encodeURIComponent(accountId)}&name=${encodeURIComponent(hostname)}&per_page=50`
  )
  const zone = Array.isArray(zones)
    ? zones.find((item) => item.name === hostname || hostname.endsWith(`.${item.name}`))
    : null
  if (!zone) {
    throw new Error(`Cloudflare does not find a zone for ${hostname}. Add the domain to this account first.`)
  }
  return zone
}
