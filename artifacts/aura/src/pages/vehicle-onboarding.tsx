import { useState, useRef, ChangeEvent } from "react";
import { useParams } from "wouter";
import {
  useGetVehicleOnboarding,
  getGetVehicleOnboardingQueryKey,
  useCreateVehicleOnboardingUpload,
  useFinalizeVehicleOnboardingMedia,
  useSubmitVehicleOnboarding,
} from "@workspace/api-client-react";
import { 
  CarFront, Loader2, UploadCloud, CheckCircle2, 
  AlertCircle, ShieldCheck, FileImage
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const schema = z.object({
  registration: z.string().min(1, "Registration is required").max(40),
  vinChassis: z.string().max(80).optional(),
  make: z.string().min(1, "Make is required").max(80),
  model: z.string().min(1, "Model is required").max(80),
  year: z.coerce.number().min(1900, "Invalid year").optional().or(z.literal(0).transform(() => undefined)).or(z.nan().transform(() => undefined)),
  colour: z.string().max(50).optional(),
  mileage: z.coerce.number().min(0, "Invalid mileage").max(10000000).optional().or(z.literal(0).transform(() => undefined)).or(z.nan().transform(() => undefined)),
  notes: z.string().max(4000).optional(),
});

type FormValues = z.infer<typeof schema>;

export default function VehicleOnboarding() {
  const { token = "" } = useParams<{ token: string }>();
  const onboarding = useGetVehicleOnboarding(token, { query: { retry: false, queryKey: getGetVehicleOnboardingQueryKey(token) } });
  const [submitted, setSubmitted] = useState(false);
  const data = onboarding.data;

  if (onboarding.isLoading) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex flex-col items-center justify-center p-6 text-[#1A1A1A]">
        <Loader2 className="w-8 h-8 animate-spin text-[#A97142]" />
        <p className="mt-4 font-medium text-sm text-[#505050]">Loading secure portal...</p>
      </div>
    );
  }

  if (onboarding.isError || !data) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex flex-col items-center justify-center p-6 text-[#1A1A1A] text-center">
        <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mb-4">
          <AlertCircle className="w-8 h-8 text-red-600" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight mb-2">Link Unavailable</h1>
        <p className="text-[#505050] max-w-sm">
          This secure link is invalid or has expired. Please contact your dealership for a new link.
        </p>
      </div>
    );
  }

  if (data.state === "expired") {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex flex-col items-center justify-center p-6 text-[#1A1A1A] text-center">
        <div className="w-16 h-16 rounded-full bg-orange-100 flex items-center justify-center mb-4">
          <AlertCircle className="w-8 h-8 text-orange-600" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight mb-2">Link Expired</h1>
        <p className="text-[#505050] max-w-sm">
          This onboarding link has expired. Please contact your dealership for a new one.
        </p>
      </div>
    );
  }

  if (data.state === "submitted" || submitted) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex flex-col items-center justify-center p-6 text-[#1A1A1A] text-center">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", bounce: 0.5 }}
          className="w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center mb-6"
        >
          <CheckCircle2 className="w-10 h-10 text-emerald-600" />
        </motion.div>
        <h1 className="text-3xl font-bold tracking-tight mb-3">Vehicle Added</h1>
        <p className="text-[#505050] max-w-sm leading-relaxed">
          Thank you, {data.customerName}. Your vehicle details and media have been securely received.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A]">
      <div className="h-1.5 bg-[#A97142] w-full" />
      
      <main className="max-w-xl mx-auto px-4 py-8 sm:py-12 pb-24">
        <div className="mb-8">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-[#A97142] mb-3">
            <ShieldCheck className="w-4 h-4" />
            Secure Onboarding
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Vehicle Details</h1>
          <p className="text-[#505050] leading-relaxed">
            Welcome back, {data.customerName}. Please provide your vehicle details and any relevant photos or videos before your service.
          </p>
        </div>
        
        <OnboardingForm token={token} onSubmitted={() => setSubmitted(true)} existingMedia={data.media} />
      </main>
    </div>
  );
}

function OnboardingForm({ 
  token, 
  onSubmitted,
  existingMedia
}: { 
  token: string; 
  onSubmitted: () => void;
  existingMedia: any[];
}) {
  const submit = useSubmitVehicleOnboarding();
  const { toast } = useToast();
  const [isUploading, setIsUploading] = useState(false);
  
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      registration: "",
      vinChassis: "",
      make: "",
      model: "",
      colour: "",
      notes: "",
    },
  });

  const onSubmit = async (data: FormValues) => {
    try {
      await submit.mutateAsync({ token, data });
      onSubmitted();
    } catch (e: any) {
      toast({
        title: "Submission failed",
        description: e.response?.data?.error || "We could not save your vehicle details. Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-10">
      <MediaUploader token={token} initialMedia={existingMedia} isUploading={isUploading} setIsUploading={setIsUploading} />
      
      <div className="bg-white rounded-3xl p-6 sm:p-8 shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-black/5">
        <h2 className="text-lg font-bold mb-6 flex items-center gap-2">
          <CarFront className="w-5 h-5 text-[#A97142]" />
          Vehicle Information
        </h2>
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <FormField
                control={form.control}
                name="make"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[#505050]">Make</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Toyota" className="bg-[#F8F9FA] border-black/10 rounded-xl h-12" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="model"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[#505050]">Model</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Hilux" className="bg-[#F8F9FA] border-black/10 rounded-xl h-12" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            
            <FormField
              control={form.control}
              name="registration"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[#505050]">Registration / License Plate</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. GXX 1234" className="bg-[#F8F9FA] border-black/10 rounded-xl h-12 uppercase" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={form.control}
              name="vinChassis"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[#505050]">VIN / Chassis Number <span className="font-normal text-black/40">(Optional)</span></FormLabel>
                  <FormControl>
                    <Input placeholder="17-character VIN" className="bg-[#F8F9FA] border-black/10 rounded-xl h-12 uppercase" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <div className="grid grid-cols-2 gap-5">
              <FormField
                control={form.control}
                name="year"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[#505050]">Year <span className="font-normal text-black/40">(Optional)</span></FormLabel>
                    <FormControl>
                      <Input type="number" placeholder="2024" className="bg-[#F8F9FA] border-black/10 rounded-xl h-12" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="colour"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[#505050]">Colour <span className="font-normal text-black/40">(Optional)</span></FormLabel>
                    <FormControl>
                      <Input placeholder="Silver" className="bg-[#F8F9FA] border-black/10 rounded-xl h-12" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            
            <FormField
              control={form.control}
              name="mileage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[#505050]">Current Mileage <span className="font-normal text-black/40">(Optional)</span></FormLabel>
                  <FormControl>
                    <Input type="number" placeholder="e.g. 45000" className="bg-[#F8F9FA] border-black/10 rounded-xl h-12" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[#505050]">Additional Notes <span className="font-normal text-black/40">(Optional)</span></FormLabel>
                  <FormControl>
                    <Textarea 
                      placeholder="Any known issues, modifications, or specific concerns..." 
                      className="bg-[#F8F9FA] border-black/10 rounded-xl min-h-[100px] resize-y" 
                      {...field} 
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button 
              type="submit" 
              className="w-full h-14 text-base font-bold rounded-xl bg-[#A97142] hover:bg-[#8F5F36] text-white shadow-lg shadow-[#A97142]/20 mt-4 disabled:opacity-50"
              disabled={submit.isPending || isUploading}
            >
              {submit.isPending ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : isUploading ? (
                "Please wait for uploads to finish..."
              ) : (
                "Submit Vehicle"
              )}
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}


function MediaUploader({ token, initialMedia, isUploading, setIsUploading }: { token: string, initialMedia: any[], isUploading: boolean, setIsUploading: (val: boolean) => void }) {
  const [uploads, setUploads] = useState<any[]>(initialMedia || []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const createUpload = useCreateVehicleOnboardingUpload();
  const finalizeUpload = useFinalizeVehicleOnboardingMedia();
  const { toast } = useToast();

  const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];
  const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
  const ALLOWED_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES];

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    
    if (fileInputRef.current) fileInputRef.current.value = "";

    const currentImages = uploads.filter(u => u.kind === 'image').length;
    const currentVideos = uploads.filter(u => u.kind === 'video').length;
    
    let imgCount = currentImages;
    let vidCount = currentVideos;
    
    const validFiles = files.filter(f => {
      const isImage = ALLOWED_IMAGE_TYPES.includes(f.type);
      const isVideo = ALLOWED_VIDEO_TYPES.includes(f.type);
      
      if (!isImage && !isVideo) {
        toast({ title: "Unsupported format", description: `${f.name} is not a supported image or video.`, variant: "destructive" });
        return false;
      }
      
      if (isImage) {
        if (f.size > 15 * 1024 * 1024) {
          toast({ title: "File too large", description: `${f.name} exceeds 15MB limit for images.`, variant: "destructive" });
          return false;
        }
        if (imgCount >= 12) {
          toast({ title: "Limit reached", description: "You can only upload up to 12 photos.", variant: "destructive" });
          return false;
        }
        imgCount++;
      }
      
      if (isVideo) {
        if (f.size > 150 * 1024 * 1024) {
          toast({ title: "File too large", description: `${f.name} exceeds 150MB limit for videos.`, variant: "destructive" });
          return false;
        }
        if (vidCount >= 3) {
          toast({ title: "Limit reached", description: "You can only upload up to 3 videos.", variant: "destructive" });
          return false;
        }
        vidCount++;
      }
      
      return true;
    });

    if (!validFiles.length) return;

    setIsUploading(true);
    
    for (const file of validFiles) {
      try {
        const kind = ALLOWED_IMAGE_TYPES.includes(file.type) ? "image" : "video";
        
        // 1. Request presigned URL
        const res = (await createUpload.mutateAsync({
          token,
          data: {
            kind,
            mimeType: file.type,
            originalName: file.name
          }
        })) as any;
        
        const mediaId = res.mediaId;
        const maxBytes = res.maxBytes || (kind === "video" ? 150 * 1024 * 1024 : 15 * 1024 * 1024);
        
        if (file.size > maxBytes) {
           toast({ title: "File too large", description: `${file.name} exceeds server limit of ${Math.floor(maxBytes / 1024 / 1024)}MB.`, variant: "destructive" });
           continue;
        }
        
        // 2. PUT to presigned URL
        const uploadRes = await fetch(res.uploadUrl, {
          method: "PUT",
          body: file,
          headers: {
            "Content-Type": file.type
          }
        });
        
        if (!uploadRes.ok) {
          throw new Error("Failed to upload file bytes");
        }
        
        // 3. Finalize
        await finalizeUpload.mutateAsync({ token, mediaId });
        
        // Optimistically add to list
        setUploads(prev => [...prev, {
          id: mediaId,
          kind,
          mimeType: file.type,
          sizeBytes: file.size,
          originalName: file.name
        }]);
        
      } catch (err: any) {
        toast({
          title: "Upload failed",
          description: `Could not upload ${file.name}.`,
          variant: "destructive"
        });
      }
    }
    
    setIsUploading(false);
  };

  const imgCount = uploads.filter(u => u.kind === 'image').length;
  const vidCount = uploads.filter(u => u.kind === 'video').length;

  return (
    <div className="bg-white rounded-3xl p-6 sm:p-8 shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-black/5">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <FileImage className="w-5 h-5 text-[#A97142]" />
          Photos & Videos
        </h2>
        <span className="text-xs font-semibold uppercase tracking-wider text-black/40">Optional</span>
      </div>
      
      <p className="text-sm text-[#505050] mb-6 leading-relaxed">
        Upload images of the vehicle's current condition, dashboard (showing mileage/warnings), or any damage.
      </p>

      {uploads.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
          <AnimatePresence>
            {uploads.map((media) => (
              <motion.div 
                key={media.id}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="aspect-square bg-[#F8F9FA] rounded-2xl border border-black/10 flex flex-col items-center justify-center p-3 relative group overflow-hidden"
              >
                {media.kind === 'video' ? (
                  <div className="text-[#A97142] font-bold text-xs">VIDEO</div>
                ) : (
                  <FileImage className="w-8 h-8 text-[#A97142]/40" />
                )}
                <div className="text-[10px] text-center font-medium mt-2 truncate w-full px-2 text-black/60">
                  {media.originalName || `media-${media.id}`}
                </div>
                
                <div className="absolute top-2 right-2 w-5 h-5 bg-emerald-500 rounded-full flex items-center justify-center text-white shadow-sm">
                  <CheckCircle2 className="w-3 h-3" />
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <div 
        onClick={() => !isUploading && fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center text-center transition-all ${
          isUploading ? "border-black/5 bg-black/5 cursor-not-allowed" : "border-[#A97142]/30 bg-[#A97142]/5 hover:bg-[#A97142]/10 cursor-pointer"
        }`}
      >
        {isUploading ? (
          <Loader2 className="w-8 h-8 animate-spin text-[#A97142] mb-3" />
        ) : (
          <UploadCloud className="w-8 h-8 text-[#A97142] mb-3" />
        )}
        <div className="font-semibold text-sm text-[#1A1A1A]">
          {isUploading ? "Uploading..." : "Tap to browse files"}
        </div>
        <div className="text-xs text-black/50 mt-1">
          {imgCount}/12 Photos (Max 15MB) · {vidCount}/3 Videos (Max 150MB)
        </div>
        <input 
          type="file"
          ref={fileInputRef}
          className="hidden"
          multiple
          accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime,video/webm"
          onChange={handleFileSelect}
        />
      </div>
    </div>
  );
}
