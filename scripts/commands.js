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
			max_length: 6000,
		},
		{
			type: 5,
			name: "photo",
			description: "Include face photos of the people in the answer",
			description_localizations: { ja: "回答に人物の顔写真を付ける" },
			required: false,
		},
	],
};

module.exports = {
	WEN_COMMAND,
};
