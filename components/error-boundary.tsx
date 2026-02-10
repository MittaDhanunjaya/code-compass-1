"use client";

import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

type Props = {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
};

type State = {
  hasError: boolean;
  error: Error | null;
};

/**
 * Catches React render errors to prevent full app crash. Use around tree that may throw
 * (e.g. editor, agent panel, streaming views). Logs and optionally reports errors.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    if (typeof console !== "undefined") {
      console.error("[ErrorBoundary]", error, errorInfo.componentStack);
    }
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center p-6 rounded-lg border border-destructive/50 bg-destructive/5 min-h-[120px] gap-3">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm font-medium text-center">Something went wrong</p>
          <p className="text-xs text-muted-foreground text-center max-w-md">
            {this.state.error.message}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
