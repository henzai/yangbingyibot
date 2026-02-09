/**
 * Share command metadata from a common spot to be used for both runtime
 * and registration.
 */

const WEN_COMMAND = {
	name: "ask",
	description: "Ask 433 a question",
	options: [
		{
			type: 3,
			name: "question",
			description: "The question you want to ask",
			required: true,
		},
	],
};

module.exports = {
	WEN_COMMAND,
};
