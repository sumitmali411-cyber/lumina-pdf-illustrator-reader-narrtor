import React, { useState, useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Upload, BookOpen, ChevronLeft, ChevronRight, Loader2, Sparkles, Download, Play, Pause, Volume2, X, HelpCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { getBackgroundPrompt, generateBackgroundImage, generateSpeech, QuotaExceededError } from './services/geminiService';
import { generateOpenImage, generateOpenSpeech } from './services/openSourceService';
import OfflineBackground from './components/OfflineBackground';
import GenerativeIllustration from './components/GenerativeIllustration';
import ArchitectureDiagram from './components/ArchitectureDiagram';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { jsPDF } from 'jspdf';
import confetti from 'canvas-confetti';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

interface PageData {
  text: string;
  imageUrl: string | null;
  audioUrl: string | null;
  loading: boolean;
  audioLoading: boolean;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pagesData, setPagesData] = useState<Record<number, PageData>>({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ completed: 0, total: 0 });
  const [backgroundProgress, setBackgroundProgress] = useState({ completed: 0, total: 0 });
  const [isBackgroundProcessing, setIsBackgroundProcessing] = useState(false);
  const [currentWordIndex, setCurrentWordIndex] = useState<number>(-1);
  const [isIllustrationDisabled, setIsIllustrationDisabled] = useState(false);
  const [showQuotaWarning, setShowQuotaWarning] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [provider, setProvider] = useState<'gemini' | 'open-source'>('gemini');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const renderTaskRef = useRef<any>(null);
  const loadingPagesRef = useRef<Set<number>>(new Set());

  const resetApp = () => {
    setFile(null);
    setPdfDoc(null);
    setPagesData({});
    setCurrentPage(1);
    setNumPages(0);
    setIsPlaying(false);
    setBackgroundProgress({ completed: 0, total: 0 });
    setIsBackgroundProcessing(false);
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      setFile(selectedFile);
      setIsProcessing(true);
      setCurrentPage(1);
      setPagesData({});
      setIsPlaying(false);
      setBackgroundProgress({ completed: 0, total: 0 });
      
      try {
        const arrayBuffer = await selectedFile.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        setPdfDoc(pdf);
        setNumPages(pdf.numPages);
        setBackgroundProgress({ completed: 0, total: pdf.numPages });
        startBackgroundGeneration(pdf);
      } catch (error) {
        console.error("Error loading PDF:", error);
      } finally {
        setIsProcessing(false);
      }
    }
  };

  const startBackgroundGeneration = async (doc: pdfjsLib.PDFDocumentProxy) => {
    setIsBackgroundProcessing(true);
    const total = doc.numPages;
    
    // Process pages in chunks or sequentially to avoid rate limits
    for (let i = 1; i <= total; i++) {
      // If app was reset or file changed, stop
      if (!doc) break;
      
      // If page already has image, skip
      if (pagesData[i]?.imageUrl) {
        setBackgroundProgress(prev => ({ ...prev, completed: i }));
        continue;
      }

      try {
        await loadPageData(i, doc, true);
        setBackgroundProgress(prev => ({ ...prev, completed: i }));
      } catch (err) {
        console.error(`Background generation failed for page ${i}`, err);
      }
      
      // Small delay to be kind to the API
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    setIsBackgroundProcessing(false);
  };

  const loadPageData = async (pageNum: number, doc: pdfjsLib.PDFDocumentProxy, isBackground = false) => {
    // If it's a background task and we already have the image, skip
    if (isBackground && pagesData[pageNum]?.imageUrl) return;
    
    // If it's the current page and we already have the image, just render and return
    if (!isBackground && pagesData[pageNum]?.imageUrl) {
      const page = await doc.getPage(pageNum);
      await renderToCanvas(page);
      return;
    }

    // Prevent concurrent loads of the same page
    if (loadingPagesRef.current.has(pageNum)) return;
    loadingPagesRef.current.add(pageNum);

    // Don't set loading state if it's a background task for a different page
    if (!isBackground || pageNum === currentPage) {
      setPagesData(prev => ({
        ...prev,
        [pageNum]: { ...prev[pageNum], loading: true, audioLoading: false, audioUrl: null, text: prev[pageNum]?.text || '', imageUrl: prev[pageNum]?.imageUrl || null }
      }));
    }

    try {
      const page = await doc.getPage(pageNum);
      
      // Only render to canvas if it's the current page
      if (pageNum === currentPage) {
        await renderToCanvas(page);
      }

      let text = pagesData[pageNum]?.text;
      if (!text) {
        const textContent = await page.getTextContent();
        text = textContent.items.map((item: any) => item.str).join(' ');
        
        setPagesData(prev => ({
          ...prev,
          [pageNum]: { ...prev[pageNum], text }
        }));
      }

      // Skip illustration if disabled
      if (isIllustrationDisabled) {
        setPagesData(prev => ({
          ...prev,
          [pageNum]: { ...prev[pageNum], loading: false }
        }));
        return;
      }

      // Get background prompt from Gemini
      const prompt = await getBackgroundPrompt(text);
      
      // Generate background image
      let imageUrl = null;
      if (provider === 'gemini') {
        imageUrl = await generateBackgroundImage(prompt);
      } else {
        imageUrl = await generateOpenImage(prompt);
      }

      setPagesData(prev => ({
        ...prev,
        [pageNum]: { ...prev[pageNum], imageUrl, loading: false }
      }));
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        console.warn("Illustration limit reached. Switching to offline mode.");
        setIsIllustrationDisabled(true);
        setPagesData(prev => ({
          ...prev,
          [pageNum]: { ...prev[pageNum], loading: false }
        }));
        return;
      }
      console.error(`Error loading page ${pageNum}:`, error);
      if (!isBackground) {
        setPagesData(prev => ({
          ...prev,
          [pageNum]: { ...prev[pageNum], text: 'Error loading page content.', imageUrl: null, loading: false }
        }));
      }
    } finally {
      loadingPagesRef.current.delete(pageNum);
    }
  };

  const renderToCanvas = async (page: pdfjsLib.PDFPageProxy) => {
    if (canvasRef.current) {
      // Cancel any existing render task
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch (err) {
          // Ignore cancellation errors
        }
      }

      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      if (context) {
        const renderContext: any = {
          canvasContext: context,
          viewport: viewport,
        };
        
        const renderTask = page.render(renderContext);
        renderTaskRef.current = renderTask;

        try {
          await renderTask.promise;
          renderTaskRef.current = null;
        } catch (error: any) {
          if (error.name === 'RenderingCancelledException') {
            // This is expected when we cancel a task
            return;
          }
          console.error("Render error:", error);
          renderTaskRef.current = null;
        }
      }
    }
  };

  const handleNarrate = async () => {
    const currentData = pagesData[currentPage];
    if (!currentData || !currentData.text) return;

    if (currentData.audioUrl) {
      if (isPlaying) {
        audioRef.current?.pause();
        setIsPlaying(false);
      } else {
        audioRef.current?.play();
        setIsPlaying(true);
      }
      return;
    }

    setCurrentWordIndex(0);
    setPagesData(prev => ({
      ...prev,
      [currentPage]: { ...prev[currentPage], audioLoading: true }
    }));

    let audioUrl = null;
    if (provider === 'gemini') {
      audioUrl = await generateSpeech(currentData.text);
    } else {
      audioUrl = await generateOpenSpeech(currentData.text);
    }
    
    setPagesData(prev => ({
      ...prev,
      [currentPage]: { ...prev[currentPage], audioUrl, audioLoading: false }
    }));

    if (audioUrl) {
      setTimeout(() => {
        audioRef.current?.play();
        setIsPlaying(true);
      }, 100);
    }
  };

  const handleRefreshIllustration = async () => {
    if (!pdfDoc || isExporting) return;
    
    setPagesData(prev => ({
      ...prev,
      [currentPage]: { ...prev[currentPage], loading: true, imageUrl: null }
    }));
    
    setIsIllustrationDisabled(false); // Try to re-enable if it was disabled
    await loadPageData(currentPage, pdfDoc);
  };

  const triggerConfetti = () => {
    const duration = 3 * 1000;
    const animationEnd = Date.now() + duration;
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 0 };

    const randomInRange = (min: number, max: number) => Math.random() * (max - min) + min;

    const interval: any = setInterval(function() {
      const timeLeft = animationEnd - Date.now();

      if (timeLeft <= 0) {
        return clearInterval(interval);
      }

      const particleCount = 50 * (timeLeft / duration);
      confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } });
      confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } });
    }, 250);
  };

  const exportWithBackgrounds = async () => {
    if (!pdfDoc || !file) return;
    setIsExporting(true);
    setExportProgress({ completed: 0, total: numPages });

    try {
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();

      for (let i = 1; i <= numPages; i++) {
        setExportProgress(prev => ({ ...prev, completed: i }));
        if (i > 1) pdf.addPage();

        let pageData = pagesData[i];
        if (!pageData || !pageData.imageUrl) {
          try {
            const page = await pdfDoc.getPage(i);
            const textContent = await page.getTextContent();
            const text = textContent.items.map((item: any) => item.str).join(' ');
            
            let imageUrl: string | null = null;
            if (!isIllustrationDisabled) {
              try {
                const prompt = await getBackgroundPrompt(text);
                imageUrl = await generateBackgroundImage(prompt);
              } catch (error) {
                if (error instanceof QuotaExceededError) {
                  setIsIllustrationDisabled(true);
                  imageUrl = null;
                } else {
                  throw error;
                }
              }
            }
            
            pageData = { text, imageUrl, loading: false, audioLoading: false, audioUrl: null };
            setPagesData(prev => ({ ...prev, [i]: pageData }));
          } catch (error) {
            console.error(`Failed to generate background for page ${i}:`, error);
            // Continue with fallback
          }
        }

        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        
        // Create a combined canvas for the export
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = viewport.width;
        exportCanvas.height = viewport.height;
        const ctx = exportCanvas.getContext('2d');

        if (ctx && pageData.imageUrl) {
          // 1. Draw Background (Full size)
          const bgImg = new Image();
          bgImg.crossOrigin = "anonymous";
          bgImg.src = pageData.imageUrl;
          await new Promise((resolve) => {
            bgImg.onload = resolve;
            bgImg.onerror = resolve;
          });
          ctx.drawImage(bgImg, 0, 0, exportCanvas.width, exportCanvas.height);

          // 2. Draw PDF Page as a centered "card" on top of the background
          const padding = exportCanvas.width * 0.05; // 5% padding
          const pdfCanvas = document.createElement('canvas');
          pdfCanvas.width = viewport.width;
          pdfCanvas.height = viewport.height;
          const pdfCtx = pdfCanvas.getContext('2d');
          if (pdfCtx) {
            await page.render({ canvasContext: pdfCtx, viewport }).promise;
            
            // Draw a slight shadow/glow for the PDF page
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 20;
            ctx.fillStyle = 'white';
            ctx.fillRect(padding, padding, exportCanvas.width - padding * 2, exportCanvas.height - padding * 2);
            
            ctx.shadowBlur = 0;
            ctx.drawImage(pdfCanvas, padding, padding, exportCanvas.width - padding * 2, exportCanvas.height - padding * 2);
          }

          const combinedImgData = exportCanvas.toDataURL('image/jpeg', 0.8);
          pdf.addImage(combinedImgData, 'JPEG', 0, 0, pdfWidth, pdfHeight);
        } else if (ctx) {
          // Fallback if no image
          await page.render({ canvasContext: ctx, viewport }).promise;
          const pageImgData = exportCanvas.toDataURL('image/png');
          pdf.addImage(pageImgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
        }
      }

      pdf.save(`Lumina_Illustrated_${file.name}`);
      if (isIllustrationDisabled) {
        setShowQuotaWarning(true);
      }
    } catch (error) {
      console.error("Export failed:", error);
    } finally {
      setIsExporting(false);
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current && isPlaying) {
      const { currentTime, duration } = audioRef.current;
      if (duration > 0) {
        const currentData = pagesData[currentPage];
        if (currentData && currentData.text) {
          const words = currentData.text.split(/\s+/).filter(w => w.length > 0);
          const index = Math.floor((currentTime / duration) * words.length);
          setCurrentWordIndex(index);
        }
      }
    }
  };

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
      setCurrentWordIndex(-1);
    }
  }, [currentPage]);

  useEffect(() => {
    if (pdfDoc) {
      loadPageData(currentPage, pdfDoc);
    }
  }, [currentPage, pdfDoc]);

  const goToNextPage = () => {
    if (currentPage < numPages) {
      setCurrentPage(prev => prev + 1);
      if (currentPage + 1 === numPages) {
        triggerConfetti();
      }
    }
  };

  const goToPrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage(prev => prev - 1);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 md:p-8 relative overflow-hidden">
      {/* Offline Atmospheric Background (Always present as base layer) */}
      <OfflineBackground />

      {/* Dynamic AI Background */}
      <AnimatePresence mode="wait">
        {pagesData[currentPage]?.imageUrl && !isIllustrationDisabled ? (
          <motion.div
            key={`bg-${pagesData[currentPage].imageUrl}-${currentPage}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.8 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.5 }}
            className="fixed inset-0 z-0"
          >
            <img 
              src={pagesData[currentPage].imageUrl || undefined} 
              alt="Page background" 
              className="w-full h-full object-cover opacity-80"
              referrerPolicy="no-referrer"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-zinc-950/70 via-transparent to-zinc-950/70" />
          </motion.div>
        ) : (
          <motion.div 
            key={`bg-fallback-${currentPage}`}
            className="fixed inset-0 z-0 bg-zinc-950"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
        )}
      </AnimatePresence>

      {/* Modals and Overlays */}
      <AnimatePresence>
        {showHelp && (
          <motion.div 
            key="help-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-zinc-950 border border-white/10 rounded-3xl w-full max-w-2xl overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-bottom border-white/10 flex items-center justify-between bg-white/5">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg vibrant-gradient flex items-center justify-center">
                    <HelpCircle className="text-white w-5 h-5" />
                  </div>
                  <h2 className="text-xl font-serif italic text-white">How Lumina Works</h2>
                </div>
                <button onClick={() => setShowHelp(false)} className="text-zinc-400 hover:text-white transition-colors">
                  <X size={24} />
                </button>
              </div>
              
              <div className="p-8 space-y-6 overflow-y-auto max-h-[70vh]">
                <div className="space-y-2">
                  <h3 className="text-purple-400 font-bold uppercase tracking-widest text-xs">Hybrid Architecture</h3>
                  <p className="text-zinc-400 text-sm leading-relaxed">
                    Lumina uses a dual-path system to ensure your reading experience is always beautiful, even without an internet connection or when API limits are reached.
                  </p>
                </div>

                <ArchitectureDiagram />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-white font-medium">
                      <div className="w-2 h-2 rounded-full bg-purple-500" />
                      <span>AI Mode (Online)</span>
                    </div>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      Uses Gemini 3 Flash to analyze text mood and Gemini 2.5 Flash Image to generate unique, high-fidelity background illustrations for every page.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-white font-medium">
                      <div className="w-2 h-2 rounded-full bg-zinc-500" />
                      <span>Offline Mode</span>
                    </div>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      Switches to local GPU-powered generative art using Vanta.js for atmospheric fog and RoughJS for procedural hand-drawn sketches.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showQuotaWarning && (
          <motion.div 
            key="quota-warning"
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            className="fixed top-24 left-1/2 -translate-x-1/2 z-[60] w-full max-w-md px-4"
          >
            <div className="bg-amber-500/90 backdrop-blur-md text-white p-4 rounded-2xl shadow-2xl border border-amber-400/50 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Sparkles className="w-5 h-5" />
                <div>
                  <p className="font-bold text-sm">AI Quota Reached</p>
                  <p className="text-xs opacity-90">Export completed using offline ambiance for some pages.</p>
                </div>
              </div>
              <button 
                onClick={() => setShowQuotaWarning(false)}
                className="p-1 hover:bg-white/20 rounded-full transition-colors"
              >
                <ChevronRight className="w-5 h-5 rotate-90" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="fixed top-0 left-0 right-0 p-6 z-50 flex justify-between items-center glass border-b-0 rounded-b-3xl mx-4 mt-4">
        <button 
          onClick={resetApp}
          className="flex items-center gap-3 hover:opacity-80 transition-opacity group"
        >
          <div className="w-10 h-10 rounded-full vibrant-gradient flex items-center justify-center shadow-lg shadow-purple-500/20 group-hover:scale-110 transition-transform">
            <BookOpen className="text-white w-5 h-5" />
          </div>
          <h1 className="text-2xl font-serif italic tracking-tight text-white">Lumina</h1>
        </button>
        
        <div className="flex items-center gap-4">
          {isExporting && (
            <div className="hidden lg:flex items-center gap-3 bg-purple-500/10 px-4 py-2 rounded-full border border-purple-500/20">
              <Loader2 className="animate-spin w-4 h-4 text-purple-400" />
              <span className="text-xs font-medium text-purple-400">
                Exporting: {exportProgress.completed}/{exportProgress.total}
              </span>
            </div>
          )}
          {isBackgroundProcessing && !isExporting && (
            <div className="hidden lg:flex items-center gap-3 bg-white/5 px-4 py-2 rounded-full border border-white/10">
              <div className="w-24 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <motion.div 
                  className="h-full vibrant-gradient"
                  initial={{ width: 0 }}
                  animate={{ width: `${(backgroundProgress.completed / backgroundProgress.total) * 100}%` }}
                />
              </div>
              <span className="text-xs font-medium text-zinc-400">
                Illustrating: {backgroundProgress.completed}/{backgroundProgress.total}
              </span>
            </div>
          )}
          {!isBackgroundProcessing && backgroundProgress.total > 0 && !isExporting && (
            <div className="hidden lg:flex items-center gap-2 text-emerald-400 text-xs font-medium bg-emerald-500/10 px-4 py-2 rounded-full border border-emerald-500/20">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>Fully Illustrated</span>
            </div>
          )}
          {pagesData[currentPage]?.loading && (
            <div className="hidden sm:flex items-center gap-2 text-purple-400 text-sm font-medium bg-white/5 px-4 py-2 rounded-full border border-white/10">
              <Loader2 className="animate-spin w-4 h-4" />
              <span className="cursive text-lg">Generating ambiance...</span>
            </div>
          )}
          {isIllustrationDisabled && (
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-800/50 border border-zinc-700 text-zinc-400 text-xs font-medium">
              <Sparkles size={12} className="text-zinc-500" />
              <span>Offline Mode</span>
            </div>
          )}
          {file && (
            <button 
              onClick={exportWithBackgrounds}
              disabled={isExporting}
              className="hidden md:flex items-center gap-2 px-4 py-2 rounded-full glass text-sm font-medium text-white hover:bg-white/10 disabled:opacity-50"
            >
              {isExporting ? <Loader2 className="animate-spin w-4 h-4" /> : <Download size={16} />}
              <span>Export Illustrated PDF</span>
            </button>
          )}
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="px-6 py-2 rounded-full bg-white text-zinc-950 font-semibold hover:bg-zinc-200 transition-all flex items-center gap-2 shadow-xl active:scale-95"
          >
            <Upload size={18} />
            <span>{file ? 'Change Book' : 'Upload PDF'}</span>
          </button>
          
          <button 
            onClick={() => setShowHelp(true)}
            className="w-10 h-10 rounded-full glass flex items-center justify-center text-white hover:bg-white/10 transition-colors"
            title="How it works"
          >
            <HelpCircle size={20} />
          </button>

          <div className="flex items-center gap-1 p-1 rounded-full glass">
            <button 
              onClick={() => setProvider('gemini')}
              className={cn(
                "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all",
                provider === 'gemini' ? "bg-purple-500 text-white" : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              Gemini
            </button>
            <button 
              onClick={() => setProvider('open-source')}
              className={cn(
                "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all",
                provider === 'open-source' ? "bg-emerald-500 text-white" : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              Open Source
            </button>
          </div>

          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            accept=".pdf" 
            className="hidden" 
          />
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 w-full max-w-4xl mt-24 mb-32">
        {!file ? (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center text-center space-y-8 py-20"
          >
            <div className="relative">
              <div className="absolute -inset-4 bg-purple-500/20 blur-3xl rounded-full" />
              <h2 className="text-6xl md:text-8xl font-serif italic text-white leading-tight">
                Read with <br />
                <span className="cursive text-purple-400 text-7xl md:text-9xl">Atmosphere</span>
              </h2>
            </div>
            <p className="text-zinc-400 text-lg max-w-md mx-auto font-light leading-relaxed">
              Upload your favorite book and let Lumina generate unique, AI-powered backgrounds and voice narration.
            </p>
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="group relative px-8 py-4 rounded-full vibrant-gradient text-white font-bold text-lg shadow-2xl shadow-purple-500/40 hover:scale-105 transition-all active:scale-95"
            >
              <div className="absolute inset-0 rounded-full bg-white/20 opacity-0 group-hover:opacity-100 transition-opacity" />
              Get Started
            </button>
          </motion.div>
        ) : (
          <div className="space-y-8">
            <div className="flex justify-between items-center px-4">
              <div className="flex items-center gap-4">
                <button 
                  onClick={goToPrevPage}
                  disabled={currentPage === 1}
                  className="p-3 rounded-full glass hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  <ChevronLeft className="text-white" />
                </button>
                <div className="text-white font-serif italic text-xl">
                  Page {currentPage} <span className="text-zinc-500 text-sm not-italic ml-1">of {numPages}</span>
                </div>
                <button 
                  onClick={goToNextPage}
                  disabled={currentPage === numPages}
                  className="p-3 rounded-full glass hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  <ChevronRight className="text-white" />
                </button>
              </div>

              <div className="flex items-center gap-4">
                <button 
                  onClick={handleNarrate}
                  disabled={pagesData[currentPage]?.audioLoading}
                  className="flex items-center gap-2 px-4 py-2 rounded-full glass text-purple-400 hover:text-purple-300 transition-all"
                >
                  {pagesData[currentPage]?.audioLoading ? (
                    <Loader2 className="animate-spin w-5 h-5" />
                  ) : isPlaying ? (
                    <Pause size={20} />
                  ) : (
                    <Play size={20} />
                  )}
                  <span className="cursive text-xl">{isPlaying ? 'Pause' : 'Listen'}</span>
                </button>

                <button 
                  onClick={handleRefreshIllustration}
                  disabled={pagesData[currentPage]?.loading}
                  className="p-3 rounded-full glass text-zinc-400 hover:text-white transition-all"
                  title="Regenerate Illustration"
                >
                  <Sparkles size={20} className={pagesData[currentPage]?.loading ? 'animate-pulse' : ''} />
                </button>
              </div>
            </div>

            <motion.div 
              key={`page-container-${currentPage}`}
              initial={{ opacity: 0, x: 20, rotateY: -5 }}
              animate={{ opacity: 1, x: 0, rotateY: 0 }}
              exit={{ opacity: 0, x: -20, rotateY: 5 }}
              transition={{ type: "spring", damping: 25, stiffness: 120 }}
              className="glass p-4 md:p-6 rounded-[2rem] shadow-2xl min-h-[60vh] relative overflow-hidden flex flex-col justify-center items-center paper-texture"
            >
              <div className="relative z-20 w-full flex flex-col items-center justify-center">
                {pagesData[currentPage]?.loading && !pagesData[currentPage]?.text && (
                  <div className="flex flex-col items-center justify-center h-[40vh] space-y-4 w-full">
                    <Loader2 className="w-12 h-12 text-purple-500 animate-spin" />
                    <p className="cursive text-2xl text-zinc-300">Rendering page...</p>
                  </div>
                )}
                
                <canvas 
                  ref={canvasRef} 
                  className="max-w-full h-auto rounded-lg shadow-inner transition-opacity duration-700 mx-auto opacity-100"
                />

                {isIllustrationDisabled && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
                    <GenerativeIllustration seed={pagesData[currentPage]?.text || "default"} />
                  </div>
                )}
              </div>

              <AnimatePresence>
                {isPlaying && pagesData[currentPage]?.text && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute inset-x-0 bottom-0 z-30 p-8 pointer-events-none flex justify-center"
                  >
                    <div className="bg-black/40 backdrop-blur-xl p-6 rounded-3xl border border-white/10 max-w-2xl text-center shadow-2xl">
                      <div className="flex flex-wrap justify-center gap-x-2 gap-y-1">
                        {pagesData[currentPage].text.split(/\s+/).filter(w => w.length > 0).map((word, i) => (
                          <span 
                            key={`word-${currentPage}-${i}`} 
                            className={cn(
                              "text-lg transition-all duration-300",
                              i === currentWordIndex 
                                ? "text-purple-400 scale-125 font-bold drop-shadow-[0_0_8px_rgba(168,85,247,0.5)]" 
                                : "text-white/40"
                            )}
                          >
                            {word}
                          </span>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="sr-only">
                {pagesData[currentPage]?.text}
              </div>
            </motion.div>
          </div>
        )}
      </main>

      <audio 
        ref={audioRef} 
        src={pagesData[currentPage]?.audioUrl || undefined} 
        onEnded={() => {
          setIsPlaying(false);
          setCurrentWordIndex(-1);
        }}
        onTimeUpdate={handleTimeUpdate}
        className="hidden"
      />

      {/* Footer Controls */}
      {file && (
        <footer className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 glass px-8 py-4 rounded-full flex items-center gap-8 shadow-2xl">
           <button 
            onClick={resetApp}
            className="flex items-center gap-2 text-zinc-400 hover:text-white transition-colors"
          >
            <BookOpen size={20} />
            <span className="hidden sm:inline">Home</span>
          </button>

          <div className="h-4 w-px bg-zinc-800" />

           <button 
            onClick={goToPrevPage}
            disabled={currentPage === 1}
            className="flex items-center gap-2 text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
          >
            <ChevronLeft size={20} />
            <span className="hidden sm:inline">Previous</span>
          </button>
          
          <div className="h-4 w-px bg-zinc-800" />
          
          <div className="flex items-center gap-4">
            <input 
              type="range" 
              min="1" 
              max={numPages} 
              value={currentPage} 
              onChange={(e) => setCurrentPage(parseInt(e.target.value))}
              className="w-32 md:w-64 accent-purple-500"
            />
          </div>

          <div className="h-4 w-px bg-zinc-800" />

          <button 
            onClick={goToNextPage}
            disabled={currentPage === numPages}
            className="flex items-center gap-2 text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight size={20} />
          </button>
        </footer>
      )}

      {/* Floating Sparkles */}
      <div className="fixed inset-0 pointer-events-none z-0 opacity-20">
        {[...Array(20)].map((_, i) => (
          <motion.div
            key={i}
            className="absolute w-1 h-1 bg-white rounded-full"
            initial={{ 
              x: Math.random() * 100 + "%", 
              y: Math.random() * 100 + "%",
              opacity: Math.random()
            }}
            animate={{ 
              y: [null, "-10%"],
              opacity: [null, 0]
            }}
            transition={{ 
              duration: Math.random() * 5 + 5, 
              repeat: Infinity,
              ease: "linear"
            }}
          />
        ))}
      </div>
    </div>
  );
}

