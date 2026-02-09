/**
 * Utilities for checking port availability and finding free ports.
 */

import { createServer } from "net";

/**
 * Check if a port is available (not in use).
 * Returns true if port is free, false if in use.
 */
export async function isPortAvailable(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    
    server.listen(port, host, () => {
      server.once("close", () => {
        resolve(true);
      });
      server.close();
    });
    
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      } else {
        // Other error, assume port is available
        resolve(true);
      }
    });
    
    // Timeout after 2 seconds
    setTimeout(() => {
      server.close();
      resolve(false); // Assume unavailable if timeout
    }, 2000);
  });
}

/**
 * Find the next available port starting from a given port.
 * Checks ports sequentially until finding one that's free.
 * Returns the first available port, or null if none found in range.
 */
export async function findAvailablePort(startPort: number, maxAttempts: number = 10): Promise<number | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }
  return null;
}

/**
 * Extract port number from error message.
 * Matches patterns like "port 3001 is already in use", "EADDRINUSE :::3001", etc.
 */
export function extractPortFromError(errorText: string): number | null {
  const patterns = [
    /port\s+(\d+)\s+is\s+already\s+in\s+use/i,
    /address\s+already\s+in\s+use.*?(\d+)/i,
    /eaddrinuse.*?(\d+)/i,
    /:(\d+).*?already\s+in\s+use/i,
  ];
  
  for (const pattern of patterns) {
    const match = errorText.match(pattern);
    if (match && match[1]) {
      const port = parseInt(match[1], 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        return port;
      }
    }
  }
  
  return null;
}
