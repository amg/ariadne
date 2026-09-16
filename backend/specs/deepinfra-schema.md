Input Schema
This is the detailed description of the input parameters in JSON Schema format

{
    "title": "AISDKIn",
    "type": "object",
    "properties": {
        "model": {
            "title": "Model",
            "description": "model name",
            "example": "meta-llama/Llama-2-70b-chat-hf",
            "type": "string"
        },
        "system": {
            "title": "System Message",
            "description": "A system message that will be part of the prompt",
            "example": "You are a professional writer. You write simple, clear, and concise content.",
            "type": "string"
        },
        "prompt": {
            "title": "Tex Prompt",
            "description": "A system message that will be part of the prompt",
            "example": "A simple text prompt. You can either use `prompt` or `messages` but not both.",
            "type": "string"
        },
        "messages": {
            "title": "Messages",
            "description": "conversation messages: (user,assistant,tool)*, including one system message anywhere. You can either use `prompt` or `messages` but not both.",
            "type": "array",
            "items": {
                "anyOf": [
                    {
                        "$ref": "#/definitions/ChatCompletionToolMessage"
                    },
                    {
                        "$ref": "#/definitions/ChatCompletionAssistantMessage"
                    },
                    {
                        "$ref": "#/definitions/ChatCompletionUserMessage"
                    },
                    {
                        "$ref": "#/definitions/ChatCompletionSystemMessage"
                    }
                ]
            }
        },
        "temperature": {
            "title": "Temperature",
            "description": "What sampling temperature to use, between 0 and 2. Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic",
            "default": 1,
            "minimum": 0,
            "maximum": 2,
            "type": "number"
        },
        "topP": {
            "title": "Top P",
            "description": "An alternative to sampling with temperature, called nucleus sampling, where the model considers the results of the tokens with top_p probability mass. So 0.1 means only the tokens comprising the top 10% probability mass are considered.",
            "default": 1,
            "exclusiveMinimum": 0,
            "maximum": 1,
            "type": "number"
        },
        "topK": {
            "title": "Top K",
            "description": "Sample from the best k (number of) tokens. 0 means off",
            "default": 0,
            "exclusiveMaximum": 1000,
            "minimum": 0,
            "type": "integer"
        },
        "maxTokens": {
            "title": "Max Tokens",
            "description": "The maximum number of tokens to generate in the chat completion.\n\nThe total length of input tokens and generated tokens is limited by the model's context length.",
            "minimum": 0,
            "maximum": 1000000,
            "type": "integer"
        },
        "stopSequences": {
            "title": "Stop Sequences",
            "description": "If set, the model will stop generating text when one of the stop sequences is generated.",
            "anyOf": [
                {
                    "type": "string"
                },
                {
                    "type": "array",
                    "items": {
                        "type": "string"
                    }
                }
            ]
        },
        "presencePenalty": {
            "title": "Presence Penalty",
            "description": "Positive values penalize new tokens based on whether they appear in the text so far, increasing the model's likelihood to talk about new topics.",
            "default": 0,
            "minimum": -2,
            "maximum": 2,
            "type": "number"
        },
        "frequencyPenalty": {
            "title": "Frequency Penalty",
            "description": "Positive values penalize new tokens based on how many times they appear in the text so far, increasing the model's likelihood to talk about new topics.",
            "default": 0,
            "minimum": -2,
            "maximum": 2,
            "type": "number"
        },
        "tools": {
            "title": "Tools",
            "description": "A set of tools the model may call.",
            "type": "object",
            "properties": {
                "tool_name": {
                    "$ref": "#/definitions/ChatTools"
                }
            }
        },
        "toolChoice": {
            "title": "Tool Choice",
            "description": "Controls which (if any) function is called by the model. none means the model will not call a function and instead generates a message. auto means the model can pick between generating a message or calling a function. specifying a particular function choice is not supported currently.none is the default when no functions are present. auto is the default if functions are present.",
            "type": "string"
        },
        "seed": {
            "title": "Seed",
            "description": "Seed for random number generator. If not provided, a random seed is used. Determinism is not guaranteed.",
            "exclusiveMaximum": 9223372036854776000,
            "minimum": 0,
            "type": "integer"
        },
        "maxSteps": {
            "title": "Max Steps",
            "description": "Maximum number of sequential LLM calls (steps), e.g. when you use tool calls.",
            "exclusiveMaximum": 9223372036854776000,
            "minimum": 1,
            "type": "integer"
        }
    },
    "required": [
        "model",
        "prompt",
        "messages"
    ],
    "definitions": {
        "ChatCompletionToolMessage": {
            "title": "ChatCompletionToolMessage",
            "type": "object",
            "properties": {
                "role": {
                    "title": "Role",
                    "description": "the role of the author of this message",
                    "default": "tool",
                    "enum": [
                        "tool"
                    ],
                    "type": "string"
                },
                "content": {
                    "title": "Content",
                    "type": "array",
                    "items": {
                        "type": {
                            "$ref": "#/definitions/ToolResult"
                        }
                    }
                }
            },
            "required": [
                "content",
                "tool_call_id"
            ]
        },
        "ChatCompletionMessageToolCall": {
            "title": "ChatCompletionMessageToolCall",
            "type": "object",
            "properties": {
                "toolCallId": {
                    "title": "Tool Call Id",
                    "description": "the id of the tool call",
                    "type": "string"
                },
                "toolName": {
                    "title": "Tool Name",
                    "description": "the name of the tool",
                    "type": "string"
                },
                "args": {
                    "title": "Arguments",
                    "description": "the function arguments, generated by the model in JSON format. the model does not always generate valid JSON, and may hallucinate parameters not defined by your function schema",
                    "type": "string"
                }
            },
            "required": [
                "id",
                "type",
                "function"
            ]
        },
        "ChatCompletionAssistantMessage": {
            "title": "ChatCompletionAssistantMessage",
            "type": "object",
            "properties": {
                "role": {
                    "title": "Role",
                    "description": "the role of the author of this message",
                    "default": "assistant",
                    "enum": [
                        "assistant"
                    ],
                    "type": "string"
                },
                "content": {
                    "title": "Content",
                    "description": "the message content",
                    "anyOf": [
                        {
                            "type": "string"
                        },
                        {
                            "$ref": "#/definitions/ChatCompletionMessageToolCall"
                        }
                    ]
                }
            }
        },
        "ChatCompletionUserMessage": {
            "title": "ChatCompletionUserMessage",
            "type": "object",
            "properties": {
                "role": {
                    "title": "Role",
                    "description": "the role of the author of this message",
                    "default": "user",
                    "enum": [
                        "user"
                    ],
                    "type": "string"
                },
                "content": {
                    "title": "Content",
                    "description": "the message content",
                    "type": "string"
                }
            },
            "required": [
                "content"
            ]
        },
        "ChatCompletionSystemMessage": {
            "title": "ChatCompletionSystemMessage",
            "type": "object",
            "properties": {
                "role": {
                    "title": "Role",
                    "description": "the role of the author of this message",
                    "default": "system",
                    "enum": [
                        "system"
                    ],
                    "type": "string"
                },
                "content": {
                    "title": "Content",
                    "description": "the message content",
                    "type": "string"
                }
            },
            "required": [
                "content"
            ]
        },
        "ChatTools": {
            "title": "ChatTools",
            "type": "object",
            "properties": {
                "description": {
                    "title": "Description",
                    "type": "string"
                },
                "parameters": {
                    "title": "Parameters",
                    "type": "object"
                },
                "execute": {
                    "title": "Function",
                    "type": "function"
                }
            },
            "required": [
                "execute",
                "parameters",
                "description"
            ]
        },
        "ToolResult": {
            "title": "Tool Result",
            "type": "object",
            "properties": {
                "toolCallId": {
                    "title": "Tool Call Id",
                    "description": "the id of the tool call",
                    "type": "string"
                },
                "toolName": {
                    "title": "Tool Name",
                    "description": "the name of the tool",
                    "type": "string"
                },
                "result": {
                    "title": "Result",
                    "description": "the result of the tool call",
                    "type": "string"
                }
            },
            "required": [
                "toolCallId",
                "result"
            ]
        }
    }
}
Output Schema
This is the detailed description of the output parameters in JSON Schema format

{
    "title": "AISDKOut",
    "type": "object",
    "properties": {
        "text": {
            "title": "Text",
            "description": "generated text",
            "type": "string"
        },
        "finishReason": {
            "description": "the reason the model stopped generating tokens. stop if the model hit a natural stop point or a provided stop sequence, length if the maximum number of tokens specified in the request was reached, tool_calls if the model called a tool.",
            "allOf": [
                {
                    "$ref": "#/definitions/FinishReason"
                }
            ]
        },
        "usage": {
            "title": "Usage",
            "description": "usage data for the completion request",
            "allOf": [
                {
                    "$ref": "#/definitions/UsageInfo"
                }
            ]
        }
    },
    "required": [
        "usage"
    ],
    "definitions": {
        "FinishReason": {
            "title": "FinishReason",
            "description": "An enumeration.",
            "enum": [
                "stop",
                "length",
                "tool_calls"
            ],
            "type": "string"
        },
        "UsageInfo": {
            "title": "UsageInfo",
            "type": "object",
            "properties": {
                "promptTokens": {
                    "title": "Prompt Tokens",
                    "description": "number of tokens in the prompt",
                    "default": 0,
                    "type": "integer"
                },
                "totalTokens": {
                    "title": "Total Tokens",
                    "description": "total number of tokens in the completion (prompt + completion)",
                    "default": 0,
                    "type": "integer"
                },
                "completionTokens": {
                    "title": "Completion Tokens",
                    "description": "number of tokens generated in the completion",
                    "default": 0,
                    "type": "integer"
                }
            }
        }
    }
}
Streaming Schema
This is the detailed description of the output stream parameters in JSON Schema format

{
    "title": "AISDKStreamOut",
    "type": "object",
    "properties": {
        "textStream": {
            "title": "Text Stream",
            "description": "an async generator of chat generated text chunks, can be more than one",
            "type": "array",
            "items": {
                "type": "string"
            }
        },
        "finishReason": {
            "description": "the reason the model stopped generating tokens. stop if the model hit a natural stop point or a provided stop sequence, length if the maximum number of tokens specified in the request was reached, tool_calls if the model called a tool.",
            "allOf": [
                {
                    "$ref": "#/definitions/FinishReason"
                }
            ]
        },
        "usage": {
            "title": "Usage",
            "description": "usage data about request and response",
            "allOf": [
                {
                    "$ref": "#/definitions/UsageInfo"
                }
            ]
        }
    },
    "required": [
        "textStream",
        "usage"
    ],
    "definitions": {
        "FinishReason": {
            "title": "FinishReason",
            "description": "An enumeration.",
            "enum": [
                "stop",
                "length",
                "tool_calls"
            ],
            "type": "string"
        },
        "UsageInfo": {
            "title": "UsageInfo",
            "type": "object",
            "properties": {
                "promptTokens": {
                    "title": "Prompt Tokens",
                    "description": "number of tokens in the prompt",
                    "default": 0,
                    "type": "integer"
                },
                "totalTokens": {
                    "title": "Total Tokens",
                    "description": "total number of tokens in the completion (prompt + completion)",
                    "default": 0,
                    "type": "integer"
                },
                "completionTokens": {
                    "title": "Completion Tokens",
                    "description": "number of tokens generated in the completion",
                    "default": 0,
                    "type": "integer"
                }
            }
        }
    }
}