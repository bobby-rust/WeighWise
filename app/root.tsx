import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "@remix-run/react";

export default function App() {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width,initial-scale=1"
        />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * ErrorBoundary: Global error handler for your app.
 * Catches errors not caught by route-level boundaries.
 */
export function ErrorBoundary() {
  const error = useRouteError();

  console.error("Root ErrorBoundary caught an error:", error);

  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <title>Something went wrong</title>
        <Meta />
        <Links />
      </head>
      <body>
        <div style={{ textAlign: "center", marginTop: "50px" }}>
          <h1>Oops! Something went wrong.</h1>
          {isRouteErrorResponse(error) ? (
            <p>
              {error.status}: {error.statusText}
            </p>
          ) : (
            <p>
              {error?.message ||
                "An unexpected error occurred. Please try again later."}
            </p>
          )}
          <a
            href="/"
            style={{ textDecoration: "underline", color: "blue" }}
          >
            Return Home
          </a>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
