import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The planner runs entirely in the browser; the only server work is the
  // Canvas ICS proxy (CORS) and the optional advisory AI calls.
  reactStrictMode: true,
  typedRoutes: true,
}

export default nextConfig
