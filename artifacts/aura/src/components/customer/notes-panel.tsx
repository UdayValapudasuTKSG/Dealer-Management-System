import { useState } from "react";
import {
  useCreateCustomerNote,
  useDeleteCustomerNote,
  getGetCustomerOverviewQueryKey,
  type CustomerNote,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, MessageSquarePlus, Trash2 } from "lucide-react";

export function NotesPanel({
  customerId,
  notes,
}: {
  customerId: number;
  notes: CustomerNote[];
}) {
  const [body, setBody] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createNote = useCreateCustomerNote();
  const deleteNote = useDeleteCustomerNote();

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getGetCustomerOverviewQueryKey(customerId),
    });

  const add = async () => {
    if (!body.trim()) return;
    try {
      await createNote.mutateAsync({ id: customerId, data: { body: body.trim() } });
      setBody("");
      await invalidate();
      toast({ title: "Note added" });
    } catch {
      toast({ title: "Could not add note", variant: "destructive" });
    }
  };

  const remove = async (noteId: number) => {
    try {
      await deleteNote.mutateAsync({ id: customerId, noteId });
      await invalidate();
      toast({ title: "Note removed" });
    } catch {
      toast({ title: "Could not delete note", variant: "destructive" });
    }
  };

  return (
    <Card className="glass-panel border-none shadow-lg">
      <CardContent className="p-6 space-y-5">
        <div className="space-y-3">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a note about this client…"
            className="bg-white/[0.04] border-white/10 min-h-[80px]"
          />
          <div className="flex justify-end">
            <Button
              onClick={add}
              disabled={createNote.isPending || !body.trim()}
              size="sm"
              className="bg-primary hover:bg-primary/90 text-white rounded-full px-5 gap-2"
            >
              {createNote.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <MessageSquarePlus className="w-3.5 h-3.5" />
              )}
              Add Note
            </Button>
          </div>
        </div>

        {notes.length === 0 ? (
          <p className="text-sm text-muted-foreground font-light text-center py-4">
            No notes yet.
          </p>
        ) : (
          <div className="space-y-3">
            {notes.map((note) => (
              <div
                key={note.id}
                className="group p-4 rounded-2xl bg-white/[0.03] border border-white/5"
              >
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {note.body}
                </p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {note.author ? `${note.author} · ` : ""}
                    {new Date(note.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => remove(note.id)}
                    disabled={deleteNote.isPending}
                    className="h-7 w-7 rounded-full text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity hover:text-primary"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
