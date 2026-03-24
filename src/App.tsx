import React, { useState, useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Upload, BookOpen, ChevronLeft, ChevronRight, Loader2, Sparkles, Download, Play, Pause, Volume2, X, HelpCircle, Menu, Settings, Info, History, Layers, Moon, Sun, Type, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { generateSpeech, generateSpeechPCM, createWavHeader, QuotaExceededError, summarizeText } from './services/geminiService';
import { generateOpenSpeech } from './services/openSourceService';
import { offlineSpeech } from './services/offlineSpeechService';
import OfflineBackground from './components/OfflineBackground';
import ArchitectureDiagram from './components/ArchitectureDiagram';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { jsPDF } from 'jspdf';
import confetti from 'canvas-confetti';
import JSZip from 'jszip';
import { Document, Packer, Paragraph, TextRun } from 'docx';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

interface PageData {
  text: string;
  audioUrl: string | null;
  loading: boolean;
  audioLoading: boolean;
  summary?: string | null;
  summaryLoading?: boolean;
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
  const [isExportingAudiobook, setIsExportingAudiobook] = useState(false);
  const [audiobookProgress, setAudiobookProgress] = useState({ completed: 0, total: 0 });
  const [currentWordIndex, setCurrentWordIndex] = useState<number>(-1);
  const [showQuotaWarning, setShowQuotaWarning] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [provider, setProvider] = useState<'gemini' | 'open-source' | 'offline'>('gemini');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [autoPlayNext, setAutoPlayNext] = useState(false);
  const [voice, setVoice] = useState<'Kore' | 'Fenrir' | 'Zephyr'>('Kore');
  const [pageHistory, setPageHistory] = useState<number[]>([]);
  const [fontFamily, setFontFamily] = useState<string>('font-sans');
  const [fontSize, setFontSize] = useState<string>('text-lg md:text-2xl');
  const [darkMode, setDarkMode] = useState<boolean>(true);
  const [isAutoPlayEnabled, setIsAutoPlayEnabled] = useState<boolean>(true);
  const [speechRate, setSpeechRate] = useState<number>(1);
  const [customPronunciations, setCustomPronunciations] = useState<{word: string, pronunciation: string}[]>([]);
  const [touchStartX, setTouchStartX] = useState<number | null>(null);
  const [touchEndX, setTouchEndX] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const renderTaskRef = useRef<any>(null);
  const loadingPagesRef = useRef<Set<number>>(new Set());
  const currentPageRef = useRef(currentPage);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

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
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      setFile(selectedFile);
      setIsProcessing(true);
      setCurrentPage(1);
      setPagesData({});
      setIsPlaying(false);
      
      try {
        const arrayBuffer = await selectedFile.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        setPdfDoc(pdf);
        setNumPages(pdf.numPages);
      } catch (error) {
        console.error("Error loading PDF:", error);
      } finally {
        setIsProcessing(false);
      }
    }
  };

  const loadPageData = async (pageNum: number, doc: pdfjsLib.PDFDocumentProxy) => {
    // Prevent concurrent loads of the same page
    if (loadingPagesRef.current.has(pageNum)) return;
    loadingPagesRef.current.add(pageNum);

    // Don't set loading state if it's a background task for a different page
    if (pageNum === currentPage) {
      setPagesData(prev => ({
        ...prev,
        [pageNum]: { ...prev[pageNum], loading: false, audioLoading: false, audioUrl: null, text: prev[pageNum]?.text || '' }
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
    } catch (error) {
      console.error(`Error loading page ${pageNum}:`, error);
      setPagesData(prev => ({
        ...prev,
        [pageNum]: { ...prev[pageNum], text: 'Error loading page content.', loading: false }
      }));
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

      const scale = 1.5;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      
      const outputScale = window.devicePixelRatio || 1;

      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = "100%";
      canvas.style.maxWidth = Math.floor(viewport.width) + "px";
      canvas.style.height = "auto";

      const transform = outputScale !== 1
        ? [outputScale, 0, 0, outputScale, 0, 0]
        : null;

      if (context) {
        const renderContext: any = {
          canvasContext: context,
          transform: transform,
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

  useEffect(() => {
    if (currentPage > 0) {
      setPageHistory(prev => {
        if (prev[prev.length - 1] === currentPage) return prev;
        const newHistory = [...prev, currentPage];
        if (newHistory.length > 10) newHistory.shift();
        return newHistory;
      });
    }
  }, [currentPage]);

  const handleSummarize = async () => {
    const currentData = pagesData[currentPage];
    if (!currentData || !currentData.text) return;

    setPagesData(prev => ({
      ...prev,
      [currentPage]: { ...prev[currentPage], summaryLoading: true }
    }));

    const summary = await summarizeText(currentData.text);

    setPagesData(prev => ({
      ...prev,
      [currentPage]: { ...prev[currentPage], summary, summaryLoading: false }
    }));
  };

  const applyPronunciations = (text: string) => {
    let result = text;
    for (const { word, pronunciation } of customPronunciations) {
      if (word && pronunciation) {
        try {
          const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`\\b${escapedWord}\\b`, 'gi');
          result = result.replace(regex, pronunciation);
        } catch (e) {
          // Ignore invalid regex
        }
      }
    }
    return result;
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
        offlineSpeech.speak(applyPronunciations(currentData.text), {
          rate: speechRate,
          onBoundary: (index) => setCurrentWordIndex(index),
          onEnd: () => {
            setIsPlaying(false);
            setCurrentWordIndex(-1);
            if (isAutoPlayEnabled && currentPage < numPages) {
              setAutoPlayNext(true);
              setCurrentPage(prev => {
                const next = prev + 1;
                if (next === numPages) triggerConfetti();
                return next;
              });
            }
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
        setTimeout(() => {
          if (audioRef.current) {
            audioRef.current.playbackRate = speechRate;
            audioRef.current.play().catch(e => console.error("Playback failed:", e));
            setIsPlaying(true);
            if (audioRef.current.currentTime === 0) {
              setCurrentWordIndex(0);
            }
          }
        }, 50);
      }
      return;
    }

    setPagesData(prev => ({
      ...prev,
      [currentPage]: { ...prev[currentPage], audioLoading: true }
    }));

    const requestedPage = currentPage;

    let audioUrl = null;
    const textToSpeak = applyPronunciations(currentData.text);
    if (provider === 'gemini') {
      audioUrl = await generateSpeech(textToSpeak, voice);
    } else {
      audioUrl = await generateOpenSpeech(textToSpeak);
    }
    
    setPagesData(prev => ({
      ...prev,
      [requestedPage]: { ...prev[requestedPage], audioUrl, audioLoading: false }
    }));

    if (audioUrl) {
      setTimeout(() => {
        if (audioRef.current && currentPageRef.current === requestedPage) {
          audioRef.current.playbackRate = speechRate;
          audioRef.current.play().catch(e => console.error("Playback failed:", e));
          setIsPlaying(true);
          setCurrentWordIndex(0);
        }
      }, 100);
    }
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

  const exportAudiobook = async () => {
    if (!pdfDoc || !file) return;
    setIsExportingAudiobook(true);
    
    try {
      const allTextChunks: string[] = [];
      setAudiobookProgress({ completed: 0, total: numPages });
      
      for (let i = 1; i <= numPages; i++) {
        let text = pagesData[i]?.text;
        if (!text) {
          const page = await pdfDoc.getPage(i);
          const textContent = await page.getTextContent();
          text = textContent.items.map((item: any) => item.str).join(' ');
        }
        
        text = applyPronunciations(text);
        
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
        let currentChunk = "";
        
        for (const sentence of sentences) {
          if (currentChunk.length + sentence.length > 500) {
            if (currentChunk.trim()) allTextChunks.push(currentChunk.trim());
            currentChunk = sentence;
          } else {
            currentChunk += " " + sentence;
          }
        }
        if (currentChunk.trim()) allTextChunks.push(currentChunk.trim());
        
        setAudiobookProgress(prev => ({ ...prev, completed: i }));
      }

      setAudiobookProgress({ completed: 0, total: allTextChunks.length });
      
      const pcmChunks: Uint8Array[] = [];
      let totalPcmLength = 0;
      
      for (let i = 0; i < allTextChunks.length; i++) {
        const chunkText = allTextChunks[i];
        if (!chunkText) {
          setAudiobookProgress(prev => ({ ...prev, completed: i + 1 }));
          continue;
        }
        
        let pcmData: Uint8Array | null = null;
        let retries = 3;
        while (retries > 0 && !pcmData) {
          try {
            pcmData = await generateSpeechPCM(`Read this text with a professional and immersive voice: ${chunkText}`, voice);
            if (!pcmData) throw new Error("Null PCM data");
          } catch (err) {
            retries--;
            if (retries === 0) {
              console.warn(`Failed to generate speech for chunk ${i}`);
            } else {
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        }
        
        if (pcmData) {
          pcmChunks.push(pcmData);
          totalPcmLength += pcmData.length;
        }
        
        setAudiobookProgress(prev => ({ ...prev, completed: i + 1 }));
        await new Promise(r => setTimeout(r, 500));
      }
      
      if (pcmChunks.length > 0) {
        const wavHeader = createWavHeader(totalPcmLength, 24000);
        const wavData = new Uint8Array(wavHeader.length + totalPcmLength);
        wavData.set(wavHeader);
        
        let offset = wavHeader.length;
        for (const pcm of pcmChunks) {
          wavData.set(pcm, offset);
          offset += pcm.length;
        }
        
        const blob = new Blob([wavData], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `${file.name.replace('.pdf', '')}_audiobook.wav`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        triggerConfetti();
      } else {
        alert("Failed to generate audiobook. Please try again later.");
      }
      
    } catch (error) {
      console.error("Audiobook export failed:", error);
      alert("An error occurred while exporting the audiobook.");
    } finally {
      setIsExportingAudiobook(false);
    }
  };

  const exportEpub = async () => {
    if (!pdfDoc || !file) return;
    setIsExporting(true);
    setExportProgress({ completed: 0, total: numPages });

    try {
      const zip = new JSZip();
      
      zip.file("mimetype", "application/epub+zip");
      
      const metaInf = zip.folder("META-INF");
      metaInf?.file("container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

      const oebps = zip.folder("OEBPS");
      
      let manifestItems = '';
      let spineItems = '';
      
      for (let i = 1; i <= numPages; i++) {
        setExportProgress(prev => ({ ...prev, completed: i }));
        let pageData = pagesData[i];
        let text = pageData?.text;

        if (!text) {
          const page = await pdfDoc.getPage(i);
          const textContent = await page.getTextContent();
          text = textContent.items.map((item: any) => item.str).join(' ');
        }

        const htmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Page ${i}</title></head>
<body>
  <p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
</body>
</html>`;
        
        oebps?.file(`page_${i}.xhtml`, htmlContent);
        manifestItems += `<item id="page_${i}" href="page_${i}.xhtml" media-type="application/xhtml+xml"/>\n`;
        spineItems += `<itemref idref="page_${i}"/>\n`;
      }

      const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${file.name.replace('.pdf', '')}</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">urn:uuid:12345</dc:identifier>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`;

      oebps?.file("content.opf", contentOpf);

      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${file.name.replace('.pdf', '')}.epub`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    } catch (error) {
      console.error("EPUB export failed:", error);
    } finally {
      setIsExporting(false);
    }
  };

  const exportDocx = async () => {
    if (!pdfDoc || !file) return;
    setIsExporting(true);
    setExportProgress({ completed: 0, total: numPages });

    try {
      const children: any[] = [];

      for (let i = 1; i <= numPages; i++) {
        setExportProgress(prev => ({ ...prev, completed: i }));
        let pageData = pagesData[i];
        let text = pageData?.text;

        if (!text) {
          const page = await pdfDoc.getPage(i);
          const textContent = await page.getTextContent();
          text = textContent.items.map((item: any) => item.str).join(' ');
        }

        children.push(
          new Paragraph({
            children: [new TextRun(text)],
          })
        );
      }

      const doc = new Document({
        sections: [{ properties: {}, children }],
      });

      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${file.name.replace('.pdf', '')}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    } catch (error) {
      console.error("DOCX export failed:", error);
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
      audioRef.current.playbackRate = speechRate;
    }
    if (provider === 'offline' && isPlaying) {
      // Offline speech requires restarting to change rate, but let's just update next time
    }
  }, [speechRate]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    offlineSpeech.stop();
    setIsPlaying(false);
    setCurrentWordIndex(-1);
  }, [currentPage]);

  useEffect(() => {
    if (autoPlayNext && pagesData[currentPage]?.text) {
      setAutoPlayNext(false);
      handleNarrate();
    }
  }, [autoPlayNext, currentPage, pagesData]);

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

  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchStartX(e.targetTouches[0].clientX);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    setTouchEndX(e.targetTouches[0].clientX);
  };

  const handleTouchEnd = () => {
    if (!touchStartX || !touchEndX) return;
    const distance = touchStartX - touchEndX;
    const isLeftSwipe = distance > 50;
    const isRightSwipe = distance < -50;
    
    if (isLeftSwipe) {
      goToNextPage();
    } else if (isRightSwipe) {
      goToPrevPage();
    }
    
    setTouchStartX(null);
    setTouchEndX(null);
  };

  return (
    <div className={cn("min-h-screen flex overflow-hidden transition-colors duration-500", darkMode ? "dark bg-zinc-950 text-white" : "bg-zinc-50 text-zinc-900")}>
      {/* Sidebar */}
      <AnimatePresence mode="wait">
        {isSidebarOpen && (
          <motion.aside
            initial={isMobile ? { x: -300 } : { width: 0 }}
            animate={isMobile ? { x: 0 } : { width: 280 }}
            exit={isMobile ? { x: -300 } : { width: 0 }}
            className={cn(
              "z-50 flex flex-col glass border-r border-white/10 h-screen overflow-hidden shrink-0",
              isMobile ? "fixed inset-y-0 left-0 w-[280px]" : "relative"
            )}
          >
            <div className="w-[280px] h-full flex flex-col">
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
                  <div className="space-y-2">
                    <button 
                      onClick={exportEpub}
                      disabled={isExporting || isExportingAudiobook}
                      className="w-full px-4 py-3 rounded-xl bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 transition-all flex items-center gap-3 text-sm font-medium text-blue-400 disabled:opacity-50"
                    >
                      {isExporting ? <Loader2 className="animate-spin w-4 h-4" /> : <Download size={18} />}
                      <span>Export EPUB</span>
                    </button>
                    <button 
                      onClick={exportDocx}
                      disabled={isExporting || isExportingAudiobook}
                      className="w-full px-4 py-3 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 transition-all flex items-center gap-3 text-sm font-medium text-indigo-400 disabled:opacity-50"
                    >
                      {isExporting ? <Loader2 className="animate-spin w-4 h-4" /> : <Download size={18} />}
                      <span>Export DOCX</span>
                    </button>
                    <button 
                      onClick={exportAudiobook}
                      disabled={isExporting || isExportingAudiobook}
                      className="w-full px-4 py-3 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 transition-all flex items-center gap-3 text-sm font-medium text-emerald-400 disabled:opacity-50"
                    >
                      {isExportingAudiobook ? <Loader2 className="animate-spin w-4 h-4" /> : <Download size={18} />}
                      <span>Export Audiobook</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Progress */}
              {isExportingAudiobook && (
                <div className="p-4 rounded-2xl bg-white/5 border border-white/10 space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Generating Audio</span>
                    <span className="text-[10px] font-mono text-emerald-400">{audiobookProgress.completed}/{audiobookProgress.total}</span>
                  </div>
                  <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <motion.div 
                      className="h-full bg-emerald-500"
                      initial={{ width: 0 }}
                      animate={{ width: `${(audiobookProgress.completed / Math.max(1, audiobookProgress.total)) * 100}%` }}
                    />
                  </div>
                </div>
              )}

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

              {/* Voice Selection */}
              {provider === 'gemini' && (
                <div className="space-y-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 px-2">Voice</p>
                  <div className="grid grid-cols-3 gap-2">
                    {['Kore', 'Fenrir', 'Zephyr'].map((v) => (
                      <button
                        key={v}
                        onClick={() => setVoice(v as any)}
                        className={`p-2 rounded-xl border text-xs font-medium transition-all ${
                          voice === v 
                            ? 'bg-purple-500/20 border-purple-500/50 text-purple-300' 
                            : 'bg-white/5 border-white/10 text-zinc-400 hover:bg-white/10'
                        }`}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Speech Rate */}
              <div className="space-y-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 px-2 flex justify-between">
                  <span>Speech Rate</span>
                  <span>{speechRate}x</span>
                </p>
                <input
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={speechRate}
                  onChange={(e) => setSpeechRate(parseFloat(e.target.value))}
                  className="w-full accent-purple-500"
                />
              </div>

              {/* Custom Pronunciations */}
              <div className="space-y-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 px-2">Custom Pronunciations</p>
                <div className="space-y-2">
                  {customPronunciations.map((cp, idx) => (
                    <div key={idx} className="flex gap-2">
                      <input
                        type="text"
                        value={cp.word}
                        onChange={(e) => {
                          const newCp = [...customPronunciations];
                          newCp[idx].word = e.target.value;
                          setCustomPronunciations(newCp);
                        }}
                        placeholder="Word"
                        className="w-1/2 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-zinc-300 focus:outline-none focus:border-purple-500/50"
                      />
                      <input
                        type="text"
                        value={cp.pronunciation}
                        onChange={(e) => {
                          const newCp = [...customPronunciations];
                          newCp[idx].pronunciation = e.target.value;
                          setCustomPronunciations(newCp);
                        }}
                        placeholder="Pronunciation"
                        className="w-1/2 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-zinc-300 focus:outline-none focus:border-purple-500/50"
                      />
                      <button
                        onClick={() => {
                          const newCp = [...customPronunciations];
                          newCp.splice(idx, 1);
                          setCustomPronunciations(newCp);
                        }}
                        className="p-2 text-zinc-500 hover:text-red-400 transition-colors"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setCustomPronunciations([...customPronunciations, { word: '', pronunciation: '' }])}
                    className="w-full py-2 border border-dashed border-white/20 rounded-xl text-xs text-zinc-400 hover:text-zinc-300 hover:border-white/40 transition-colors"
                  >
                    + Add Pronunciation
                  </button>
                </div>
              </div>

              {/* Typography Settings */}
              <div className="space-y-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 px-2 flex items-center gap-2">
                  <Type size={12} />
                  Typography
                </p>
                <div className="space-y-2">
                  <select
                    value={fontFamily}
                    onChange={(e) => setFontFamily(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-zinc-300 focus:outline-none focus:border-purple-500/50 appearance-none"
                  >
                    <option value="font-sans">Sans Serif</option>
                    <option value="font-serif">Serif</option>
                    <option value="font-mono">Monospace</option>
                    <option value="cursive">Cursive</option>
                  </select>
                  <select
                    value={fontSize}
                    onChange={(e) => setFontSize(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-zinc-300 focus:outline-none focus:border-purple-500/50 appearance-none"
                  >
                    <option value="text-base md:text-lg">Small</option>
                    <option value="text-lg md:text-2xl">Medium</option>
                    <option value="text-xl md:text-3xl">Large</option>
                    <option value="text-2xl md:text-4xl">Extra Large</option>
                  </select>
                </div>
              </div>

              {/* Theme & Playback Settings */}
              <div className="space-y-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 px-2">Preferences</p>
                <div className="space-y-2">
                  <button
                    onClick={() => setDarkMode(!darkMode)}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-all text-sm font-medium text-zinc-300"
                  >
                    <div className="flex items-center gap-3">
                      {darkMode ? <Moon size={18} className="text-purple-400" /> : <Sun size={18} className="text-amber-400" />}
                      <span>{darkMode ? 'Dark Mode' : 'Light Mode'}</span>
                    </div>
                    <div className={cn(
                      "w-8 h-4 rounded-full transition-colors relative",
                      darkMode ? "bg-purple-500" : "bg-zinc-600"
                    )}>
                      <div className={cn(
                        "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
                        darkMode ? "left-4" : "left-0.5"
                      )} />
                    </div>
                  </button>
                  <button
                    onClick={() => setIsAutoPlayEnabled(!isAutoPlayEnabled)}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-all text-sm font-medium text-zinc-300"
                  >
                    <div className="flex items-center gap-3">
                      <Play size={18} className={isAutoPlayEnabled ? "text-emerald-400" : "text-zinc-500"} />
                      <span>Auto-play Next Page</span>
                    </div>
                    <div className={cn(
                      "w-8 h-4 rounded-full transition-colors relative",
                      isAutoPlayEnabled ? "bg-emerald-500" : "bg-zinc-600"
                    )}>
                      <div className={cn(
                        "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
                        isAutoPlayEnabled ? "left-4" : "left-0.5"
                      )} />
                    </div>
                  </button>
                </div>
              </div>

              {/* History */}
              {pageHistory.length > 1 && (
                <div className="space-y-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 px-2 flex items-center gap-2">
                    <History size={12} />
                    History
                  </p>
                  <div className="flex flex-wrap gap-2 px-2">
                    {pageHistory.slice(0, -1).reverse().map((p, i) => (
                      <button
                        key={`${p}-${i}`}
                        onClick={() => setCurrentPage(p)}
                        className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-zinc-400 hover:bg-white/10 hover:text-white transition-colors"
                      >
                        Page {p}
                      </button>
                    ))}
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
          <motion.div 
            key={`bg-fallback-${currentPage}`}
            className="absolute inset-0 z-0 bg-zinc-950"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
        </AnimatePresence>

        {/* Top Bar for Mobile & Desktop Sidebar Toggle */}
        {(!isSidebarOpen || isMobile) && (
          <header className="relative z-30 p-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button 
                onClick={() => setIsSidebarOpen(true)}
                className="p-2 rounded-xl glass text-white hover:bg-white/10 transition-all"
              >
                <Menu size={24} />
              </button>
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
        )}

        {/* Main Reader */}
        <main 
          className="flex-1 relative z-10 overflow-y-auto px-4 py-6 md:p-8 flex flex-col items-center"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {!file ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center w-full max-w-md mx-auto">
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="glass p-8 md:p-10 rounded-[2rem] border border-white/10 flex flex-col items-center gap-6 w-full shadow-2xl"
              >
                <div className="w-16 h-16 rounded-2xl vibrant-gradient flex items-center justify-center shadow-lg shadow-purple-500/20">
                  <BookOpen className="text-white w-8 h-8" />
                </div>
                
                <div className="space-y-2">
                  <h2 className="text-2xl font-serif italic text-white">Welcome to Lumina</h2>
                  <p className="text-zinc-400 text-sm leading-relaxed">
                    Upload a PDF to begin your immersive reading experience with AI-powered visuals and narration.
                  </p>
                </div>
                
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full group relative px-8 py-4 rounded-xl vibrant-gradient text-white font-bold shadow-lg hover:scale-[1.02] transition-all active:scale-[0.98]"
                >
                  <span className="flex items-center justify-center gap-3">
                    <Upload size={20} />
                    Select PDF
                  </span>
                </button>
              </motion.div>
            </div>
          ) : (
            <div className="w-full max-w-4xl space-y-6 pb-24">
              {/* Reader Header */}
              <div className="flex flex-col md:flex-row justify-between items-center gap-4 px-2">
                <div className="flex items-center gap-2 bg-white/5 p-1.5 rounded-full border border-white/10 w-full md:w-auto justify-between md:justify-start">
                  <button 
                    onClick={goToPrevPage}
                    disabled={currentPage === 1}
                    className="p-2 md:p-2.5 rounded-full hover:bg-white/10 disabled:opacity-20 transition-all"
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <div className="px-2 md:px-4 text-white font-serif italic text-base md:text-lg min-w-[100px] text-center">
                    Page {currentPage} <span className="text-zinc-500 text-xs not-italic ml-1">/ {numPages}</span>
                  </div>
                  <button 
                    onClick={goToNextPage}
                    disabled={currentPage === numPages}
                    className="p-2 md:p-2.5 rounded-full hover:bg-white/10 disabled:opacity-20 transition-all"
                  >
                    <ChevronRight size={20} />
                  </button>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto justify-center">
                  <button 
                    onClick={handleSummarize}
                    disabled={pagesData[currentPage]?.summaryLoading}
                    className="flex-1 md:flex-none flex items-center justify-center gap-2 px-6 py-2.5 md:py-3 rounded-full bg-blue-500/20 text-blue-400 font-bold border border-blue-500/30 hover:bg-blue-500/30 transition-all active:scale-95 disabled:opacity-50"
                  >
                    {pagesData[currentPage]?.summaryLoading ? (
                      <Loader2 className="animate-spin w-5 h-5" />
                    ) : (
                      <BookOpen size={18} />
                    )}
                    <span className="cursive text-lg md:text-xl hidden md:inline">Summarize</span>
                  </button>

                  <button 
                    onClick={handleNarrate}
                    disabled={pagesData[currentPage]?.audioLoading}
                    className="flex-1 md:flex-none flex items-center justify-center gap-2 px-6 py-2.5 md:py-3 rounded-full bg-purple-500 text-white font-bold shadow-lg shadow-purple-500/20 hover:scale-105 transition-all active:scale-95 disabled:opacity-50"
                  >
                    {pagesData[currentPage]?.audioLoading ? (
                      <Loader2 className="animate-spin w-5 h-5" />
                    ) : isPlaying ? (
                      <Pause size={18} />
                    ) : (
                      <Play size={18} />
                    )}
                    <span className="cursive text-lg md:text-xl">{isPlaying ? 'Pause' : 'Listen'}</span>
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
                <div className="absolute -inset-1 bg-gradient-to-r from-purple-500/20 to-emerald-500/20 rounded-[2rem] md:rounded-[2.5rem] blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200" />
                <div className="relative glass p-3 md:p-8 rounded-[2rem] md:rounded-[2.5rem] shadow-2xl min-h-[50vh] md:min-h-[65vh] overflow-hidden flex flex-col items-center justify-center paper-texture border border-white/10">
                  
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
                      className="max-w-full max-h-[70vh] object-contain rounded-xl shadow-2xl transition-all duration-1000 mx-auto opacity-100 border border-white/5"
                    />
                  </div>

                  {/* Highlighting Overlay */}
                  <AnimatePresence>
                    {isPlaying && pagesData[currentPage]?.text && (
                      <motion.div 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="absolute inset-x-0 bottom-0 z-30 p-4 md:p-8 pointer-events-none flex justify-center"
                      >
                        <div className="bg-black/60 backdrop-blur-2xl p-4 md:p-8 rounded-[1.5rem] md:rounded-[2rem] border border-white/10 max-w-3xl text-center shadow-2xl">
                          <div className={cn("flex flex-wrap justify-center gap-x-2 md:gap-x-3 gap-y-1 md:gap-y-2", fontFamily)}>
                            {pagesData[currentPage].text.split(/\s+/).filter(w => w.length > 0).map((word, i) => (
                              <span 
                                key={`word-${currentPage}-${i}`} 
                                className={cn(
                                  "transition-all duration-300",
                                  fontSize,
                                  i === currentWordIndex 
                                    ? "text-purple-400 scale-110 md:scale-125 font-bold drop-shadow-[0_0_15px_rgba(168,85,247,0.8)]" 
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

                {/* Summary Display */}
                {pagesData[currentPage]?.summary && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-6 p-6 rounded-2xl bg-blue-500/10 border border-blue-500/20 glass"
                  >
                    <h3 className="text-sm font-bold text-blue-400 mb-3 flex items-center gap-2 uppercase tracking-wider">
                      <Sparkles size={16} />
                      Page Summary
                    </h3>
                    <p className="text-zinc-300 text-sm leading-relaxed">
                      {pagesData[currentPage].summary}
                    </p>
                  </motion.div>
                )}
              </motion.div>
            </div>
          )}
        </main>

        {/* Floating Page Controls */}
        {file && (
          <div className="absolute bottom-4 md:bottom-8 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 md:gap-4 w-[90%] md:w-auto max-w-md">
            <div className="glass px-4 md:px-6 py-2 md:py-3 rounded-full flex items-center justify-between md:justify-center gap-4 md:gap-6 shadow-2xl border border-white/10 w-full">
              <div className="flex items-center gap-2 md:gap-3 flex-1">
                <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 hidden md:inline">Go to</span>
                <input 
                  type="range" 
                  min="1" 
                  max={numPages} 
                  value={currentPage} 
                  onChange={(e) => setCurrentPage(parseInt(e.target.value))}
                  className="w-full md:w-48 accent-purple-500"
                />
              </div>
              <div className="h-4 w-px bg-zinc-800 hidden md:block" />
              <div className="flex items-center gap-2 shrink-0">
                <History size={14} className="text-zinc-500 hidden md:block" />
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
          if (isAutoPlayEnabled && currentPage < numPages) {
            setAutoPlayNext(true);
            setCurrentPage(prev => {
              const next = prev + 1;
              if (next === numPages) triggerConfetti();
              return next;
            });
          }
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

