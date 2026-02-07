import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase auth session and returns the response.
 * Must be called from middleware for session cookies to work with SSR.
 */
export async function updateSession(request: NextRequest) {
  const response = NextResponse.next({
    request: { headers: request.headers },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isAuthRoute =
    pathname === "/sign-in" ||
    pathname === "/sign-up" ||
    pathname === "/auth/callback";

  if (user && isAuthRoute) {
    const redirectRes = NextResponse.redirect(new URL("/", request.url));
    // Preserve session cookies from refresh
    response.cookies.getAll().forEach((c) => redirectRes.cookies.set(c.name, c.value));
    return redirectRes;
  }

  if (!user && !isAuthRoute && !pathname.startsWith("/api/")) {
    const redirectRes = NextResponse.redirect(new URL("/sign-in", request.url));
    // Preserve any cookies from refresh attempt
    response.cookies.getAll().forEach((c) => redirectRes.cookies.set(c.name, c.value));
    return redirectRes;
  }

  return response;
}
