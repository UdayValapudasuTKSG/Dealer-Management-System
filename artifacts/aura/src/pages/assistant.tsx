import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAnthropicConversations,
  useGetAnthropicConversation,
  useCreateAnthropicConversation,
  useDeleteAnthropicConversation,
  getListAnthropicMessagesQueryKey,
  getGetAnthropicConversationQueryKey,
  getListAnthropicConversationsQueryKey,
  type AnthropicMessage,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Plus, MessageSquare, Trash2, Send, Bot, User } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { format } from "date-fns";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed space-y-2 [&_p]:m-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:tracking-tight [&_h3]:font-semibold [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-black/5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_table]:w-full [&_table]:text-xs [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-primary [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

export default function Assistant() {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingConversationId, setStreamingConversationId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight stream when switching conversations or unmounting.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, [activeId]);

  const { data: conversations, isLoading: isLoadingConvos } = useListAnthropicConversations();
  const { data: activeConversation, isLoading: isLoadingChat } = useGetAnthropicConversation(activeId!, {
    query: { enabled: !!activeId, queryKey: getGetAnthropicConversationQueryKey(activeId!) },
  });

  const createMutation = useCreateAnthropicConversation({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListAnthropicConversationsQueryKey() });
        setActiveId(data.id);
      },
    },
  });

  const deleteMutation = useDeleteAnthropicConversation({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAnthropicConversationsQueryKey() });
        if (activeId) setActiveId(null);
      },
    },
  });

  useEffect(() => {
    if (conversations?.length && !activeId) {
      setActiveId(conversations[0].id);
    }
  }, [conversations, activeId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeConversation?.messages, streamingContent]);

  const handleSend = async () => {
    if (!input.trim() || !activeId || isStreaming) return;

    const conversationId = activeId;
    const userMessage = input.trim();
    setInput("");
    setIsStreaming(true);
    setStreamingContent("");
    setStreamingConversationId(conversationId);

    // Optimistically update UI
    if (activeConversation) {
      const tempMsg: AnthropicMessage = {
        id: Date.now(),
        conversationId,
        role: "user",
        content: userMessage,
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueryData(
        getGetAnthropicConversationQueryKey(conversationId),
        (old: any) => ({
          ...old,
          messages: [...(old?.messages || []), tempMsg],
        })
      );
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`${import.meta.env.BASE_URL}api/anthropic/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: userMessage }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Request failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }
      if (!response.body) throw new Error("No body in response");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let streamText = "";
      let buffer = "";

      const processFrame = (frame: string) => {
        const line = frame.trim();
        if (!line.startsWith("data:")) return;
        try {
          const data = JSON.parse(line.slice(line.indexOf(":") + 1).trim());
          if (data.content) {
            streamText += data.content;
            setStreamingContent(streamText);
          }
        } catch {
          // ignore malformed frame
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line; keep the last partial
        // fragment in the buffer until its terminator arrives.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) processFrame(frame);
      }
      if (buffer.trim()) processFrame(buffer);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.error("Stream error:", error);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsStreaming(false);
      setStreamingContent("");
      setStreamingConversationId(null);
      queryClient.invalidateQueries({ queryKey: getGetAnthropicConversationQueryKey(conversationId) });
      queryClient.invalidateQueries({ queryKey: getListAnthropicMessagesQueryKey(conversationId) });
    }
  };

  return (
    <div className="h-full flex flex-col md:flex-row gap-6 p-6">
      <div className="w-full md:w-80 flex flex-col gap-4 glass-panel rounded-2xl p-4">
        <Button 
          onClick={() => createMutation.mutate({ data: { title: "New Conversation" } })}
          className="w-full bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/20"
        >
          <Plus className="w-4 h-4 mr-2" />
          New Chat
        </Button>
        
        <ScrollArea className="flex-1">
          {isLoadingConvos ? (
            <div className="flex justify-center p-4"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : (
            <div className="space-y-2">
              {conversations?.map((conv) => (
                <div 
                  key={conv.id}
                  className={`group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${
                    activeId === conv.id ? "bg-primary/10 text-primary font-medium" : "hover:bg-black/5"
                  }`}
                  onClick={() => setActiveId(conv.id)}
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    <MessageSquare className="w-4 h-4 shrink-0" />
                    <span className="truncate text-sm">{conv.title || "Conversation"}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 opacity-0 group-hover:opacity-100 hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMutation.mutate({ id: conv.id });
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      <div className="flex-1 flex flex-col glass-panel rounded-2xl overflow-hidden relative">
        {!activeId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <Bot className="w-16 h-16 mb-4 opacity-20" />
            <p>Select or create a conversation</p>
          </div>
        ) : (
          <>
            <div 
              ref={scrollRef}
              className="flex-1 overflow-y-auto p-6 space-y-6"
            >
              {isLoadingChat ? (
                <div className="flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
              ) : (
                <>
                  <div className="flex flex-col items-center justify-center py-10 opacity-50">
                    <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                      <Bot className="w-6 h-6 text-primary" />
                    </div>
                    <p className="text-sm tracking-widest uppercase font-medium">Aura Concierge</p>
                  </div>
                  
                  {activeConversation?.messages.map((msg) => (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`flex gap-4 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
                    >
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                        msg.role === "user" ? "bg-black text-white" : "bg-primary text-white"
                      }`}>
                        {msg.role === "user" ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                      </div>
                      <div className={`max-w-[80%] rounded-2xl px-5 py-3 ${
                        msg.role === "user" 
                          ? "bg-black text-white rounded-tr-sm" 
                          : "bg-white border border-border shadow-sm rounded-tl-sm"
                      }`}>
                        {msg.role === "user" ? (
                          <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</p>
                        ) : (
                          <ChatMarkdown content={msg.content} />
                        )}
                      </div>
                    </motion.div>
                  ))}
                  
                  {isStreaming && streamingConversationId === activeId && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex gap-4"
                    >
                      <div className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center shrink-0">
                        <Bot className="w-4 h-4" />
                      </div>
                      <div className="max-w-[80%] rounded-2xl px-5 py-3 bg-white border border-border shadow-sm rounded-tl-sm">
                        <ChatMarkdown content={streamingContent} />
                        <span className="inline-block w-1.5 h-4 mt-1 bg-primary animate-pulse align-middle" />
                      </div>
                    </motion.div>
                  )}
                </>
              )}
            </div>

            <div className="p-4 bg-white/50 backdrop-blur-md border-t border-border">
              <form 
                onSubmit={(e) => { e.preventDefault(); handleSend(); }}
                className="relative max-w-4xl mx-auto"
              >
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask the concierge..."
                  className="pr-12 h-14 rounded-2xl bg-white shadow-sm border-border text-base focus-visible:ring-primary/20"
                  disabled={isStreaming}
                />
                <Button 
                  type="submit" 
                  size="icon"
                  className="absolute right-2 top-2 h-10 w-10 rounded-xl bg-primary hover:bg-primary/90 text-white"
                  disabled={!input.trim() || isStreaming}
                >
                  <Send className="w-4 h-4" />
                </Button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}