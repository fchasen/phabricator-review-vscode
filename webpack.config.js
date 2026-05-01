'use strict';

const path = require('path');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');

/**
 * @param {{ tsconfig: string, target: import('webpack').Configuration['target'], entry: Record<string, string>, outDir: string, externals?: Record<string,string>, mode?: 'development'|'production' }} opts
 * @returns {import('webpack').Configuration}
 */
function makeConfig(opts) {
	return {
		mode: opts.mode || 'production',
		target: opts.target,
		entry: opts.entry,
		output: {
			path: path.resolve(__dirname, opts.outDir),
			filename: '[name].js',
			chunkFilename: opts.target === 'web' ? '[name].chunk.js' : undefined,
			publicPath: opts.target === 'web' ? 'auto' : undefined,
			libraryTarget: opts.target === 'node' ? 'commonjs2' : undefined,
			devtoolModuleFilenameTemplate: '../[resource-path]',
		},
		devtool: opts.mode === 'production' ? 'source-map' : 'eval-source-map',
		externals: opts.externals,
		resolve: {
			extensions: ['.ts', '.tsx', '.js', '.jsx'],
		},
		module: {
			rules: [
				{
					test: /\.tsx?$/,
					exclude: /node_modules/,
					use: [
						{
							loader: 'esbuild-loader',
							options: {
								loader: 'tsx',
								target: 'es2020',
								tsconfig: opts.tsconfig,
							},
						},
					],
				},
				{
					test: /\.css$/,
					use: ['style-loader', 'css-loader'],
				},
				{
					test: /\.(ttf|woff2?|eot|otf)$/,
					type: 'asset/resource',
				},
			],
		},
		plugins: [
			new ForkTsCheckerWebpackPlugin({
				typescript: {
					configFile: opts.tsconfig,
				},
			}),
		],
	};
}

module.exports = (_env, argv) => {
	const mode = argv && argv.mode === 'production' ? 'production' : 'development';
	return [
		makeConfig({
			tsconfig: 'tsconfig.json',
			target: 'node',
			entry: { extension: './src/extension.ts' },
			outDir: 'dist',
			externals: { vscode: 'commonjs vscode' },
			mode,
		}),
		makeConfig({
			tsconfig: 'tsconfig.webviews.json',
			target: 'web',
			entry: { 'revisionOverview': './webviews/editorWebview/index.tsx' },
			outDir: 'dist/webviews',
			mode,
		}),
	];
};
