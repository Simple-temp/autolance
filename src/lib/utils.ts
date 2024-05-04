import { Message } from "@/types/Message";
import { type ClassValue, clsx } from "clsx";
// import { GroqMessage } from "@/types/Message";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { twMerge } from "tailwind-merge";
import { useState } from 'react'


// import { getStreamResponse } from '@src/utils'
// this is what the getStreamResponse file might look like.
import axios from 'axios';

export const getStreamResponse = async (api: string, inputString: string, callback: (value: string) => void) => {
  try {
    const response = await axios.post(api, inputString);
    if (!response.data) {
      console.error('Failed to get response from API:', response);
      return;
    }

    callback(response.data);
  } catch (error) {
    console.error('Failed to get response from API:', error);
  }
};

// Set up the interface for the Graph Stream
type NodeHistory = {
	node: string
	message: string
}

interface GraphState {
	isRunning: boolean
	shouldDisplay: boolean
	uiMessage: string | null
}

interface DefaultGraphNodeData {
	[key: string]: string
}

interface BaseGraphStreamState<NodeData = DefaultGraphNodeData> {
	currentNode: string | null
	nodeData: NodeData
	nodeHistory: NodeHistory[]
	graphState: GraphState
	finalOutput: string | null
}

// Set up the interface for the graph nodes we care about monitoring.
// We want to specify the nodes to observe, and a few properties for each node:
// - The formattedName is the name of the node as it appears in the stream
// export const productVisionGraph: ObservedGraphNodes = {
// 	'Product Vision Graph': {
// 		formattedName: 'Product Vision Graph',
// 		actionText: 'Analyzing your message',
// 		isGraphNode: true,
// 	},
// 	'extraction_classifier': {
// 		formattedName: 'Extraction Classifier',
// 		actionText: 'Analyzing your message ',
// 	},
// 	'extract_objectives': {
// 		formattedName: 'Extract Objectives',
// 		actionText: 'Extracting business objectives',
// 	},
// 	vision_rewriter: {
// 		formattedName: 'Vision Writer',
// 		actionText: 'Rewriting the vision statement',
// 		isFinalOutput: true,
// 	},
// }

type ObservedGraphNode = {
	formattedName: string
	actionText: string
	isGraphNode?: boolean
	isFinalOutput?: boolean
}

type ObservedGraphNodes = Record<string, ObservedGraphNode>


// Set up the interface for events streaming back from LangGraph
interface StreamingEventDataChunk {
	kwargs: {
		content: string
	}
}

interface StreamingEvent {
	event: string
	run_id: string
	name: string
	data?: {
		chunk?: StreamingEventDataChunk
	}
}


export const useGraphStream = () => {
	const defaultGraphState: BaseGraphStreamState = {
		graphState: {
			isRunning: false,
			shouldDisplay: false,
			uiMessage: null,
		},
		currentNode: null,
		nodeHistory: [],
		nodeData: {},
		finalOutput: null,
	}

	const [graphStream, setGraphStream] =
		useState<BaseGraphStreamState>(defaultGraphState)

	const resetGraphStream = () => {
		setGraphStream(defaultGraphState)
	}

	const handleJsonResponse = (jsonString: string) => {
		try {
			return JSON.parse(
				`[${jsonString.replace(/}{"event"/g, '},{"event"')}]`,
			) as StreamingEvent[]
		} catch (error) {
			console.error('Failed to parse JSON:', error, jsonString)
			return [] as StreamingEvent[]
		}
	}

	const handleStreamResponse = (
		api: string,
		inputString: string,
		graphNodes: ObservedGraphNodes,
	) => {
		getStreamResponse(api, inputString, value => {
			// Get the streamedEvents from the response
			const streamedEvents = handleJsonResponse(value)

			// Group events by consecutive run_id so that we can batch our state updates without missing node changes
			const groupedEvents: StreamingEvent[][] = []
			let currentGroup: StreamingEvent[] = []

			streamedEvents.forEach(event => {
				if (
					currentGroup.length === 0 ||
					event.run_id === currentGroup[currentGroup.length - 1].run_id
				) {
					currentGroup.push(event)
				} else {
					groupedEvents.push(currentGroup)
					currentGroup = [event]
				}
			})

			// Ensure the last group is added
			if (currentGroup.length > 0) {
				groupedEvents.push(currentGroup)
			}

			// Process each group of events
			groupedEvents.forEach(group => {
				setGraphStream(prevState => {
					const newState = { ...prevState }

					group.forEach(streamedEvent => {
						console.log(streamedEvent)
						const nodeConfig = graphNodes[streamedEvent.name]
						switch (streamedEvent.event) {
							case 'on_chain_start':
								if (nodeConfig) {
									// Every time a new node (even the main graph node) begins that we care about, update the following parameters:
									// - currentNode should be updated to the new node that started streaming
									// - isRunning should always be true until on_chain_end sets it to false
									// - shouldDisplay should always be true until on_chat_model_stream sets it to false for the isFinalOutput message.
									// - uiMessage should be updated to the current node's action text
									newState.currentNode = streamedEvent.name
									newState.graphState = {
										...newState.graphState,
										isRunning: true,
										shouldDisplay: true,
										uiMessage: nodeConfig.actionText,
									}
								}
								break
							case 'on_chain_end':
								if (nodeConfig && nodeConfig.isGraphNode) {
									// Now that the graph is complete, update the following parameters:
									// - isRunning should be set to false
									// - shouldDisplay should be set to false
									// - uiMessage will be updated should be set to false
									newState.graphState = {
										...newState.graphState,
										isRunning: false,
										shouldDisplay: false,
										uiMessage: 'Finished',
									}
								} else if (nodeConfig) {
									// Every time a subnode completes, update the node history with the completed message
									newState.nodeHistory = [
										...newState.nodeHistory,
										{
											node: streamedEvent.name,
											message: newState.nodeData[streamedEvent.name] || '',
										},
									]
								}
								break
							case 'on_chat_model_stream':
								if (newState.currentNode) {
									// Append the streamed content to the current node's data
									const currentData =
										newState.nodeData[newState.currentNode] || ''
									newState.nodeData[newState.currentNode] =
										currentData +
										(streamedEvent.data?.chunk?.kwargs?.content || '')

									if (
										graphNodes[newState.currentNode] &&
										graphNodes[newState.currentNode].isFinalOutput
									) {
										// If this is the finalOutput node:
										// - Update the content for finalOutput
										// - Set shouldDisplay to false
										// - Leave isRunning as true
										newState.finalOutput =
											(newState.finalOutput || '') +
											(streamedEvent.data?.chunk?.kwargs?.content || '')
										newState.graphState.shouldDisplay = false
									}
								}
								break
						}
					})
					return newState
				})
			})

			if (
				streamedEvents.some(
					streamedEvent =>
						streamedEvent.event === 'on_chain_end' &&
						graphNodes[streamedEvent.name]?.isGraphNode,
				)
			) {
				resetGraphStream()
			}
		})
	}

	return { graphStream, handleStreamResponse }
}


export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function formatForGPT(chatHistory: Message[] | undefined) {
    if (!chatHistory) {
        return [];
    }

    const formattedHistory = chatHistory.map((message) => {
        return {
            role: message.from,
            content: message.message,
        };
    });

    formattedHistory.unshift({
        role: "system",
        content:
            "You are a highly detail-oriented assistant, tasked with extracting precise and comprehensive information from the user regarding their project needs. Your primary role is to ensure clarity in communications between the user and freelancers. Ask questions one at a time and proactively seek clarifications to eliminate any ambiguities. Do not assume details that have not been explicitly stated. Maintain a persistent inquiry to understand all aspects of the task thoroughly. If any part of the user’s description is vague or incomplete, request additional details. Facilitate a clear and precise exchange of information and confirm facts and summarize details to ensure accuracy before passing the information along to the freelancers. Your interactions should reflect a balance of professional diligence and approachability, encouraging the user to provide comprehensive information comfortably. Avoid technical errors and strive for impeccable communication to prevent any delays or confusion in project execution. Before proceeding with the project creation, MAKE SURE that you have gathered all essential information, including the URL for attachments, a budget, a final deadline, and any other valuable information that the freelancer would need to complete his work.",
    });

    // // Call GROQ API
    // const chatCompletion = await groq.chat.completions.create({
    //     "messages": formattedHistory,
    //     "model": "llama3-70b-8192",
    //     "temperature": 1,
    //     "max_tokens": 1024,
    //     "top_p": 1,
    //     "stream": true,
    //     "stop": null
    // });

    // const processedMessages: GroqMessage[] = [];
    // for await (const chunk of chatCompletion) {
    //     // Assuming each chunk has only one choice
    //     processedMessages.push({
    //         role: chunk.choices[0]?.delta?.role || "",
    //         content: chunk.choices[0]?.delta?.content || ''
    //     });
    // }

    // return processedMessages;

    return formattedHistory as ChatCompletionMessageParam[];
}
