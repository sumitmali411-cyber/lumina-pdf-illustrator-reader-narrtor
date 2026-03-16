import React, { useState, useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Upload, BookOpen, ChevronLeft, ChevronRight, Loader2, Sparkles, Download, Play, Pause, Volume2, X, HelpCircle, Menu, Settings, Info, History, Layers } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { getBackgroundPrompt, generateBackgroundImage, generateSpeech, QuotaExceededError } from './services/geminiService';
import { generateOpenImage, generateOpenSpeech } from './services/openSourceService';
import { offlineSpeech } from './services/offlineSpeechService';
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
  const [provider, setProvider] = useState<'gemini' | 'open-source' | 'offline'>('gemini');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const renderTaskRef = useRef<any>(null);
  const loadingPagesRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (mobile) setIsSidebarOpen(false);
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

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

  const renderInProgressRef = useRef<boolean>(false);

  const renderToCanvas = async (page: pdfjsLib.PDFPageProxy) => {
    if (canvasRef.current) {
      // If a render is already in progress, we should wait or cancel
      if (renderInProgressRef.current) {
        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
          } catch (err) {}
        }
      }

      renderInProgressRef.current = true;

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
          renderInProgressRef.current = false;
        } catch (error: any) {
          renderInProgressRef.current = false;
          if (error.name === 'RenderingCancelledException') {
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

    if (provider === 'offline') {
      if (isPlaying) {
        offlineSpeech.stop();
        setIsPlaying(false);
        setCurrentWordIndex(-1);
      } else {
        setIsPlaying(true);
        offlineSpeech.speak(currentData.text, {
          onBoundary: (index) => setCurrentWordIndex(index),
          onEnd: () => {
            setIsPlaying(false);
            setCurrentWordIndex(-1);
          },
          onError: () => {
            setIsPlaying(false);
            setCurrentWordIndex(-1);
          }
        });
      }
      return;
    }

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
    <div className="min-h-screen flex bg-zinc-950 text-white overflow-hidden">
      {/* Sidebar */}
      <AnimatePresence mode="wait">
        {(isSidebarOpen || !isMobile) && (
          <motion.aside
            initial={isMobile ? { x: -300 } : { width: 0 }}
            animate={isMobile ? { x: 0 } : { width: 280 }}
            exit={isMobile ? { x: -300 } : { width: 0 }}
            className={cn(
              "z-50 flex flex-col glass border-r border-white/10 h-screen overflow-hidden",
              isMobile ? "fixed inset-y-0 left-0 w-[280px]" : "relative"
            )}
          >
            <div className="p-6 flex items-center justify-between border-b border-white/5">
              <button 
                onClick={resetApp}
                className="flex items-center gap-3 hover:opacity-80 transition-opacity group"
              >
                <div className="w-8 h-8 rounded-lg vibrant-gradient flex items-center justify-center shadow-lg shadow-purple-500/20 group-hover:scale-110 transition-transform">
                  <BookOpen className="text-white w-4 h-4" />
                </div>
                <h1 className="text-xl font-serif italic tracking-tight text-white">Lumina</h1>
              </button>
              <button onClick={() => setIsSidebarOpen(false)} className="p-2 hover:bg-white/5 rounded-lg">
                {isMobile ? <X size={20} className="text-zinc-400" /> : <ChevronLeft size={20} className="text-zinc-400" />}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-8">
              {/* Main Actions */}
              <div className="space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 px-2">Library</p>
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 transition-all flex items-center gap-3 text-sm font-medium group"
                >
                  <Upload size={18} className="text-purple-400 group-hover:scale-110 transition-transform" />
                  <span>{file ? 'Change Book' : 'Upload PDF'}</span>
                </button>
                {file && (
                  <button 
                    onClick={exportWithBackgrounds}
                    disabled={isExporting}
                    className="w-full px-4 py-3 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 transition-all flex items-center gap-3 text-sm font-medium text-purple-400 disabled:opacity-50"
                  >
                    {isExporting ? <Loader2 className="animate-spin w-4 h-4" /> : <Download size={18} />}
                    <span>Export Illustrated</span>
                  </button>
                )}
              </div>

              {/* Settings / Provider */}
              <div className="space-y-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 px-2">AI Provider</p>
                <div className="grid grid-cols-1 gap-2">
                  {[
                    { id: 'gemini', label: 'Gemini', icon: Sparkles, color: 'text-purple-400' },
                    { id: 'open-source', label: 'Open Source', icon: Layers, color: 'text-emerald-400' },
                    { id: 'offline', label: 'Offline TTS', icon: Volume2, color: 'text-amber-400' }
                  ].map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setProvider(p.id as any)}
                      className={cn(
                        "flex items-center justify-between px-4 py-3 rounded-xl transition-all border",
                        provider === p.id 
                          ? "bg-white/10 border-white/20 text-white shadow-lg" 
                          : "bg-transparent border-transparent text-zinc-500 hover:bg-white/5"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <p.icon size={18} className={cn(provider === p.id ? p.color : "text-zinc-600")} />
                        <span className="text-sm font-medium">{p.label}</span>
                      </div>
                      {provider === p.id && <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Progress */}
              {isBackgroundProcessing && (
                <div className="p-4 rounded-2xl bg-white/5 border border-white/10 space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Illustrating</span>
                    <span className="text-[10px] font-mono text-purple-400">{backgroundProgress.completed}/{backgroundProgress.total}</span>
                  </div>
                  <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <motion.div 
                      className="h-full vibrant-gradient"
                      initial={{ width: 0 }}
                      animate={{ width: `${(backgroundProgress.completed / backgroundProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 border-t border-white/5 space-y-2">
              <button 
                onClick={() => setShowHelp(true)}
                className="w-full px-4 py-2 rounded-lg hover:bg-white/5 transition-all flex items-center gap-3 text-xs text-zinc-500 hover:text-white"
              >
                <Info size={16} />
                <span>How it works</span>
              </button>
              <div className="px-4 py-2 text-[10px] text-zinc-600 font-mono">
                v1.2.0 • Stable
              </div>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main Content Area */}
      <div className="flex-1 relative flex flex-col h-screen overflow-hidden">
        {/* Mobile Overlay */}
        <AnimatePresence>
          {isMobile && isSidebarOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSidebarOpen(false)}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            />
          )}
        </AnimatePresence>

        {/* Background Layers */}
        <OfflineBackground />
        <AnimatePresence mode="wait">
          {pagesData[currentPage]?.imageUrl && !isIllustrationDisabled ? (
            <motion.div
              key={`bg-${pagesData[currentPage].imageUrl}-${currentPage}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.6 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.5 }}
              className="absolute inset-0 z-0"
            >
              <img 
                src={pagesData[currentPage].imageUrl || undefined} 
                alt="Page background" 
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
              <div className="absolute inset-0 bg-gradient-to-b from-zinc-950/80 via-transparent to-zinc-950/80" />
            </motion.div>
          ) : (
            <motion.div 
              key={`bg-fallback-${currentPage}`}
              className="absolute inset-0 z-0 bg-zinc-950"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
          )}
        </AnimatePresence>

        {/* Top Bar for Mobile & Desktop Sidebar Toggle */}
        <header className="relative z-30 p-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {(!isSidebarOpen || isMobile) && (
              <button 
                onClick={() => setIsSidebarOpen(true)}
                className="p-2 rounded-xl glass text-white hover:bg-white/10 transition-all"
              >
                <Menu size={24} />
              </button>
            )}
            {isMobile && !isSidebarOpen && (
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg vibrant-gradient flex items-center justify-center">
                  <BookOpen className="text-white w-3 h-3" />
                </div>
                <span className="font-serif italic text-lg">Lumina</span>
              </div>
            )}
          </div>
          <div className="w-10" /> {/* Spacer */}
        </header>

        {/* Main Reader */}
        <main className="flex-1 relative z-10 overflow-y-auto px-4 py-8 md:p-12 flex flex-col items-center">
          {!file ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-12 max-w-2xl">
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6"
              >
                <div className="relative inline-block">
                  <div className="absolute -inset-4 bg-purple-500/20 blur-3xl rounded-full" />
                  <h2 className="text-5xl md:text-7xl font-serif italic text-white leading-tight">
                    Read with <br />
                    <span className="cursive text-purple-400 text-6xl md:text-8xl">Atmosphere</span>
                  </h2>
                </div>
                <p className="text-zinc-400 text-lg font-light leading-relaxed">
                  Upload your favorite book and let Lumina generate unique, AI-powered backgrounds and voice narration.
                </p>
              </motion.div>
              
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="group relative px-10 py-5 rounded-full vibrant-gradient text-white font-bold text-xl shadow-2xl shadow-purple-500/40 hover:scale-105 transition-all active:scale-95"
              >
                <div className="absolute inset-0 rounded-full bg-white/20 opacity-0 group-hover:opacity-100 transition-opacity" />
                <span className="flex items-center gap-3">
                  <Upload size={24} />
                  Get Started
                </span>
              </button>

              <div className="grid grid-cols-3 gap-8 pt-12">
                {[
                  { icon: Sparkles, label: 'AI Visuals' },
                  { icon: Volume2, label: 'Narration' },
                  { icon: BookOpen, label: 'Atmosphere' }
                ].map((item, i) => (
                  <div key={i} className="flex flex-col items-center gap-2">
                    <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-zinc-400">
                      <item.icon size={20} />
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="w-full max-w-4xl space-y-8">
              {/* Reader Header */}
              <div className="flex flex-col md:flex-row justify-between items-center gap-6 px-4">
                <div className="flex items-center gap-4 bg-white/5 p-1.5 rounded-full border border-white/10">
                  <button 
                    onClick={goToPrevPage}
                    disabled={currentPage === 1}
                    className="p-2.5 rounded-full hover:bg-white/10 disabled:opacity-20 transition-all"
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <div className="px-4 text-white font-serif italic text-lg min-w-[100px] text-center">
                    Page {currentPage} <span className="text-zinc-500 text-xs not-italic ml-1">/ {numPages}</span>
                  </div>
                  <button 
                    onClick={goToNextPage}
                    disabled={currentPage === numPages}
                    className="p-2.5 rounded-full hover:bg-white/10 disabled:opacity-20 transition-all"
                  >
                    <ChevronRight size={20} />
                  </button>
                </div>

                <div className="flex items-center gap-3">
                  <button 
                    onClick={handleNarrate}
                    disabled={pagesData[currentPage]?.audioLoading}
                    className="flex items-center gap-3 px-6 py-3 rounded-full bg-purple-500 text-white font-bold shadow-lg shadow-purple-500/20 hover:scale-105 transition-all active:scale-95 disabled:opacity-50"
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
                    className="p-3.5 rounded-full glass text-zinc-400 hover:text-white transition-all hover:rotate-180 duration-500"
                    title="Regenerate Illustration"
                  >
                    <Sparkles size={20} className={pagesData[currentPage]?.loading ? 'animate-pulse' : ''} />
                  </button>
                </div>
              </div>

              {/* Page View */}
              <motion.div 
                key={`page-container-${currentPage}`}
                initial={{ opacity: 0, x: 20, rotateY: -5 }}
                animate={{ opacity: 1, x: 0, rotateY: 0 }}
                exit={{ opacity: 0, x: -20, rotateY: 5 }}
                transition={{ type: "spring", damping: 25, stiffness: 120 }}
                className="relative group"
              >
                <div className="absolute -inset-1 bg-gradient-to-r from-purple-500/20 to-emerald-500/20 rounded-[2.5rem] blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200" />
                <div className="relative glass p-4 md:p-8 rounded-[2.5rem] shadow-2xl min-h-[65vh] overflow-hidden flex flex-col items-center justify-center paper-texture border border-white/10">
                  
                  <div className="relative z-20 w-full flex flex-col items-center justify-center">
                    {pagesData[currentPage]?.loading && !pagesData[currentPage]?.text && (
                      <div className="flex flex-col items-center justify-center h-[40vh] space-y-6 w-full">
                        <div className="relative">
                          <div className="absolute inset-0 bg-purple-500 blur-2xl opacity-20 animate-pulse" />
                          <Loader2 className="w-16 h-16 text-purple-500 animate-spin relative z-10" />
                        </div>
                        <p className="cursive text-3xl text-zinc-300 animate-pulse">Painting the scene...</p>
                      </div>
                    )}
                    
                    <canvas 
                      ref={canvasRef} 
                      className="max-w-full h-auto rounded-xl shadow-2xl transition-all duration-1000 mx-auto opacity-100 border border-white/5"
                    />

                    {isIllustrationDisabled && (
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-30">
                        <GenerativeIllustration seed={pagesData[currentPage]?.text || "default"} />
                      </div>
                    )}
                  </div>

                  {/* Highlighting Overlay */}
                  <AnimatePresence>
                    {isPlaying && pagesData[currentPage]?.text && (
                      <motion.div 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="absolute inset-x-0 bottom-0 z-30 p-8 pointer-events-none flex justify-center"
                      >
                        <div className="bg-black/60 backdrop-blur-2xl p-8 rounded-[2rem] border border-white/10 max-w-3xl text-center shadow-2xl">
                          <div className="flex flex-wrap justify-center gap-x-3 gap-y-2">
                            {pagesData[currentPage].text.split(/\s+/).filter(w => w.length > 0).map((word, i) => (
                              <span 
                                key={`word-${currentPage}-${i}`} 
                                className={cn(
                                  "text-xl md:text-2xl transition-all duration-300",
                                  i === currentWordIndex 
                                    ? "text-purple-400 scale-125 font-bold drop-shadow-[0_0_15px_rgba(168,85,247,0.8)]" 
                                    : "text-white/30"
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
                </div>
              </motion.div>
            </div>
          )}
        </main>

        {/* Floating Page Controls */}
        {file && (
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4">
            <div className="glass px-6 py-3 rounded-full flex items-center gap-6 shadow-2xl border border-white/10">
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Go to</span>
                <input 
                  type="range" 
                  min="1" 
                  max={numPages} 
                  value={currentPage} 
                  onChange={(e) => setCurrentPage(parseInt(e.target.value))}
                  className="w-32 md:w-48 accent-purple-500"
                />
              </div>
              <div className="h-4 w-px bg-zinc-800" />
              <div className="flex items-center gap-2">
                <History size={14} className="text-zinc-500" />
                <span className="text-xs font-mono text-zinc-400">{currentPage}/{numPages}</span>
              </div>
            </div>
          </div>
        )}
      </div>

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

      {/* Modals */}
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
              <div className="p-6 border-b border-white/10 flex items-center justify-between bg-white/5">
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
                  <h3 className="text-purple-400 font-bold uppercase tracking-widest text-xs text-left">Hybrid Architecture</h3>
                  <p className="text-zinc-400 text-sm leading-relaxed text-left">
                    Lumina uses a multi-provider system to ensure your reading experience is always beautiful and accessible.
                  </p>
                </div>

                <ArchitectureDiagram />

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4">
                  {[
                    { title: 'Gemini', desc: 'High-fidelity AI visuals and professional narration.', color: 'bg-purple-500' },
                    { title: 'Open Source', desc: 'Powered by FLUX.1 and MMS-TTS for an open experience.', color: 'bg-emerald-500' },
                    { title: 'Offline', desc: 'Zero-latency browser-based speech and generative art.', color: 'bg-amber-500' }
                  ].map((item, i) => (
                    <div key={i} className="space-y-2 text-left">
                      <div className="flex items-center gap-2 text-white font-medium">
                        <div className={cn("w-2 h-2 rounded-full", item.color)} />
                        <span className="text-sm">{item.title}</span>
                      </div>
                      <p className="text-[10px] text-zinc-500 leading-relaxed">
                        {item.desc}
                      </p>
                    </div>
                  ))}
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
            className="fixed top-8 left-1/2 -translate-x-1/2 z-[60] w-full max-w-md px-4"
          >
            <div className="bg-amber-500/90 backdrop-blur-md text-white p-4 rounded-2xl shadow-2xl border border-amber-400/50 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Sparkles className="w-5 h-5" />
                <div>
                  <p className="font-bold text-sm text-left">AI Quota Reached</p>
                  <p className="text-xs opacity-90 text-left">Switching to Offline mode for a seamless experience.</p>
                </div>
              </div>
              <button 
                onClick={() => setShowQuotaWarning(false)}
                className="p-1 hover:bg-white/20 rounded-full transition-colors"
              >
                <X size={20} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileChange} 
        accept=".pdf" 
        className="hidden" 
      />

      {/* Floating Sparkles Background */}
      <div className="fixed inset-0 pointer-events-none z-0 opacity-20 overflow-hidden">
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
              y: [null, "-20%"],
              opacity: [null, 0]
            }}
            transition={{ 
              duration: Math.random() * 10 + 10, 
              repeat: Infinity,
              ease: "linear"
            }}
          />
        ))}
      </div>
    </div>
  );
}

