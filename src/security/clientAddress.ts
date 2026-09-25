export function getClientAddress(
  forwardedFor: string | string[] | undefined,
  fallback: string | undefined
) {
  if (!isLoopback(fallback)) return fallback || 'unknown'

  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor
  const forwardedAddresses = raw?.split(',').map((address) => address.trim()).filter(Boolean) || []
  return forwardedAddresses.at(-1) || fallback || 'unknown'
}

function isLoopback(address: string | undefined) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}
