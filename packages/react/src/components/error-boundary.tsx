import React from "react"

type ErrorBoundaryProps = { children: React.ReactNode; resetKey?: number }
type ErrorBoundaryState = { hasError: boolean; error: Error | null; resetKey?: number }

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null, resetKey: props.resetKey }
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): ErrorBoundaryState | null {
    if (props.resetKey !== state.resetKey) {
      return { hasError: false, error: null, resetKey: props.resetKey }
    }
    return null
  }

  static getDerivedStateFromError(error: Error): {
    hasError: boolean
    error: Error
  } {
    return { hasError: true, error }
  }

  override render(): any {
    if (this.state.hasError && this.state.error) {
      return (
        <box style={{ flexDirection: "column", padding: 2 }}>
          <text fg="red">{this.state.error.stack || this.state.error.message}</text>
        </box>
      )
    }

    return this.props.children
  }
}
