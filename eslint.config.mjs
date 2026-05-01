import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
	{
		ignores: ['dist/**', 'out/**', 'node_modules/**', 'phabricator-client/dist-types/**'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		plugins: { 'react-hooks': reactHooks },
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
		},
		rules: {
			'@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-empty-object-type': 'off',
			'@typescript-eslint/no-require-imports': 'off',
			'react-hooks/rules-of-hooks': 'error',
			'react-hooks/exhaustive-deps': 'warn',
			'no-empty': ['error', { allowEmptyCatch: true }],
		},
	},
];
