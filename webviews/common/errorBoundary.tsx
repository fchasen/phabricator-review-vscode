import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
	children: ReactNode;
}

interface State {
	error: Error | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: undefined };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error('Webview render error:', error, info);
	}

	render(): ReactNode {
		if (this.state.error) {
			return (
				<div className="webview-error">
					<h2>Something went wrong rendering this revision.</h2>
					<pre>{this.state.error.message}</pre>
					{this.state.error.stack && <pre className="stack">{this.state.error.stack}</pre>}
				</div>
			);
		}
		return this.props.children;
	}
}
