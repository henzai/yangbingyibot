/**
 * Share command metadata from a common spot to be used for both runtime
 * and registration.
 */

export const WEN_COMMAND = {
	name: 'yby',
	description: 'Ask yby a question',
	options: [
		{
			type: 3,
			name: 'question',
			description: 'The question you want to ask',
			required: true,
		},
	],
};
