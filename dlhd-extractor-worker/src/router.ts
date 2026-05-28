import { Env, Route, RouteHandler, ErrorResponse } from './types';
import {
  addCorsHeaders,
  handleCorsPreflightRequest,
  validateApiKey,
  createAuthErrorResponse,
  checkRateLimit,
  createRateLimitErrorResponse,
  addRateLimitHeaders,
} from './middleware';

/**
 * Routes that don't require authentication
 * /dlhdprivate is public because it's called by video players from M3U8 URLs
 * (players can't set headers, and the CF Worker handles RPI auth internally)
 * /play is public because it returns M3U8 that players need to fetch frequently
 * /backends is public because it's called by the frontend to list available servers
 */
const PUBLIC_ROUTES = ['/health', '/', '/dlhdprivate', '/play', '/backends', '/key', '/segment', '/whitelist', '/whitelist-relay', '/browser', '/browser-api'];

/**
 * Routes that support query param auth (for VLC/media players that can't send headers)
 */
const QUERY_AUTH_ROUTES = ['/live/', '/play/', '/dlhdprivate', '/debug/'];

/**
 * Request Router with middleware support
 */
export class Router {
  private routes: Route[] = [];
  private env: Env;
  public ctx?: ExecutionContext;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Register a GET route
   */
  get(path: string, handler: RouteHandler): void {
    this.addRoute('GET', path, handler);
  }

  /**
   * Register a POST route
   */
  post(path: string, handler: RouteHandler): void {
    this.addRoute('POST', path, handler);
  }

  /**
   * Add a route with pattern matching
   */
  private addRoute(method: string, path: string, handler: RouteHandler): void {
    const { pattern, paramNames } = this.pathToRegex(path);
    this.routes.push({ method, pattern, paramNames, handler });
  }

  /**
   * Convert path pattern to regex
   * Supports :param syntax for path parameters
   */
  private pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    
    // Handle wildcard paths like /live/*
    if (path.endsWith('/*')) {
      const basePath = path.slice(0, -2);
      const escapedBase = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      paramNames.push('path');
      return {
        pattern: new RegExp(`^${escapedBase}/(.*)$`),
        paramNames,
      };
    }
    
    const regexStr = path.replace(/:([^/]+)/g, (_, paramName) => {
      paramNames.push(paramName);
      return '([^/]+)';
    });
    
    return {
      pattern: new RegExp(`^${regexStr}$`),
      paramNames,
    };
  }

  /**
   * Extract parameters from URL using route pattern
   */
  private extractParams(
    url: string,
    pattern: RegExp,
    paramNames: string[]
  ): Record<string, string> | null {
    const match = url.match(pattern);
    if (!match) return null;
    
    const params: Record<string, string> = {};
    paramNames.forEach((name, index) => {
      params[name] = match[index + 1];
    });
    
    return params;
  }

  /**
   * Check if a path is public (no auth required)
   */
  private isPublicRoute(path: string): boolean {
    return PUBLIC_ROUTES.some((route) => path === route || path.startsWith(route + '/'));
  }

  /**
   * Check if a path supports query param auth
   */
  private supportsQueryAuth(path: string): boolean {
    return QUERY_AUTH_ROUTES.some((route) => path.startsWith(route));
  }

  /**
   * Get API key from query param if header not present
   */
  private getApiKeyFromQuery(request: Request): string | null {
    const url = new URL(request.url);
    return url.searchParams.get('key') || url.searchParams.get('api_key');
  }

  /**
   * Handle incoming request
   */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return handleCorsPreflightRequest();
    }

    // Find matching route
    for (const route of this.routes) {
      if (route.method !== method) continue;
      
      const params = this.extractParams(path, route.pattern, route.paramNames);
      if (!params) continue;

      try {
        // Skip auth for public routes
        if (!this.isPublicRoute(path)) {
          // For routes that support query auth (like /live/*), check query param first
          let authResult;
          if (this.supportsQueryAuth(path)) {
            const queryKey = this.getApiKeyFromQuery(request);
            if (queryKey) {
              // Create a modified request with the API key in header for validation
              const modifiedHeaders = new Headers(request.headers);
              modifiedHeaders.set('X-API-Key', queryKey);
              const modifiedRequest = new Request(request.url, {
                method: request.method,
                headers: modifiedHeaders,
              });
              authResult = validateApiKey(modifiedRequest, this.env);
            } else {
              authResult = validateApiKey(request, this.env);
            }
          } else {
            // Validate API key from header only
            authResult = validateApiKey(request, this.env);
          }
          
          if (!authResult.valid) {
            return addCorsHeaders(createAuthErrorResponse(authResult));
          }

          // Check rate limit
          const rateLimitResult = await checkRateLimit(authResult.apiKey!, this.env);
          if (!rateLimitResult.allowed) {
            return addCorsHeaders(createRateLimitErrorResponse(rateLimitResult));
          }

          // Execute handler and add rate limit headers
          const response = await route.handler(request, this.env, params);
          return addCorsHeaders(addRateLimitHeaders(response, rateLimitResult));
        }

        // Public route - no auth/rate limit
        const response = await route.handler(request, this.env, params);
        return addCorsHeaders(response);
      } catch (error) {
        console.error('Route handler error:', error);
        return addCorsHeaders(this.createErrorResponse(error));
      }
    }

    // No route found
    return addCorsHeaders(this.createNotFoundResponse());
  }

  /**
   * Create error response
   */
  private createErrorResponse(error: unknown): Response {
    const errorResponse: ErrorResponse = {
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    };

    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Create 404 response
   */
  private createNotFoundResponse(): Response {
    const errorResponse: ErrorResponse = {
      success: false,
      error: 'Not found',
      code: 'NOT_FOUND',
    };

    return new Response(JSON.stringify(errorResponse), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
