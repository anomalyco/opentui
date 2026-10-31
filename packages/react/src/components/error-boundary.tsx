import React from "react"

type ErrorBoundaryProps = { children: React.ReactNode; resetKey: number }
type ErrorBoundaryState = { error: Error | null; resetKey?: number }

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): ErrorBoundaryState | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  override render(): any {
    if (this.state.error) {
      return (
        <box style={{ flexDirection: "column", padding: 2 }}>
          <text fg="red">{this.state.error.stack || this.state.error.message}</text>
        </box>
      )
    }

    return this.props.children
  }
}
