// Configurações globais
const CONFIG = {
    backendUrl: 'http://localhost:3000/api', // Ajuste conforme necessário
    maxRecordingTime: 30000, // 30 segundos
    audioFormat: 'audio/webm;codecs=opus',
    audioPath: './public/' // Caminho para os arquivos de áudio
};

// Mapeamento dos arquivos de áudio (ajustado para os arquivos existentes em /public)
const AUDIO_FILES = {
    welcome: 'Bem_vindo.wav',
    listening: 'Estou_ouvindo.wav',
    repeat: 'Por_favor_repita.wav',
    // Fluxo de criação
    reminderName: 'nome_lembrete.wav',
    reminderDate: 'dia_lembrete.wav',
    reminderTime: 'horario_lembrete.wav',
    reminderRepeat: 'repetir_lembrete.wav',
    // Edição/Exclusão
    editReminder: 'Acao_pos_editar.wav',
    deleteReminder: 'acao_pos_excluir.wav'
    // Obs.: Não há áudio específico para os dias da semana; usamos TTS quando necessário
};

// Estado da aplicação
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let currentStream = null;
let isMuted = false;
let isFirstTime = true;
let currentConversationState = 'welcome'; // Estado da conversa
let currentReminderData = {}; // Dados do lembrete sendo criado
let audioCache = new Map(); // Cache de áudios para reprodução mais rápida
let recognition = null; // Para guardar a instância da SpeechRecognition
let currentEditData = {}; // Dados para fluxo de edição
let currentDeleteData = {}; // Dados para fluxo de exclusão
let recordingStartTime = null; // Timestamp de quando a gravação começou

// Sistema de fila de áudios para evitar sobreposição
let audioQueue = [];
let isPlayingAudio = false;
let currentPlayingAudio = null;

// Função para adicionar áudio à fila
async function queueAudio(audioKey, speed = 1.0) {
    return new Promise((resolve) => {
        audioQueue.push({ audioKey, speed, resolve });
        processAudioQueue();
    });
}

// Função para processar a fila de áudios
async function processAudioQueue() {
    if (isPlayingAudio || audioQueue.length === 0) return;
    
    isPlayingAudio = true;
    const { audioKey, speed, resolve } = audioQueue.shift();
    
    try {
        await playAudioDirect(audioKey, speed);
        resolve();
    } catch (error) {
        console.error('Erro ao tocar áudio da fila:', error);
        resolve();
    } finally {
        isPlayingAudio = false;
        // Processar próximo áudio da fila
        if (audioQueue.length > 0) {
            processAudioQueue();
        }
    }
}

// Função para parar todos os áudios e limpar a fila
function stopAllAudios() {
    // Parar áudio atual
    if (currentPlayingAudio) {
        currentPlayingAudio.pause();
        currentPlayingAudio.currentTime = 0;
        currentPlayingAudio = null;
    }
    
    // Limpar fila
    audioQueue = [];
    isPlayingAudio = false;
    
    // Parar TTS
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }
}

// TTS básico com fila
function speakText(text) {
    return new Promise((resolve) => {
        if (isMuted) {
            resolve();
            return;
        }
        
        try {
            if (!('speechSynthesis' in window)) {
                console.warn('speechSynthesis não suportado. Texto:', text);
                resolve();
                return;
            }
            
            // Parar TTS anterior se houver
            window.speechSynthesis.cancel();
            
            const utter = new SpeechSynthesisUtterance(text);
            utter.lang = 'pt-BR';
            utter.rate = 1.0;
            utter.onend = () => resolve();
            utter.onerror = () => resolve();
            window.speechSynthesis.speak(utter);
        } catch (e) {
            console.warn('Falha no TTS:', e);
            resolve();
        }
    });
}

// Elementos DOM
const recordButton = document.getElementById('recordButton');
const statusIndicator = document.getElementById('status-indicator');
const feedbackContainer = document.getElementById('feedbackContainer');
const feedbackText = document.getElementById('feedbackText');

// Inicialização
async function initializeApp() {
    updateStatus('🎤', 'ready');

    await preloadImportantAudios();
    setupEventListeners();
    checkMicrophonePermission();

    // Configurar desbloqueio de áudio no primeiro clique
    setupAudioUnlockOnce();

    // Tentativa automática de reprodução com fallback TTS
    try {
        console.log('Tentando tocar mensagem de boas-vindas automaticamente...');
        await speakWelcomeMessage();
        console.log('Mensagem de boas-vindas reproduzida com sucesso!');
        isFirstTime = false;
    } catch (err) {
        console.warn('⚠️ Autoplay bloqueado pelo navegador:', err);

        // 🔄 Fallback: usa TTS imediatamente
        await speakText(
            'Bem-vindo ao sistema Memorae, sua agenda de lembretes. ' +
            'Diga "criar lembrete", "editar lembrete", "excluir lembrete", ou "ver lembretes".'
        );

        isFirstTime = false;
    }
}

// Pré-carregar áudios importantes
async function preloadImportantAudios() {
    const importantAudios = Object.keys(AUDIO_FILES);
    
    for (const audioKey of importantAudios) {
        try {
            const audioFile = AUDIO_FILES[audioKey];
            if (audioFile) {
                const audio = new Audio(`${CONFIG.audioPath}${audioFile}`);
                audio.preload = 'auto';
                audio.volume = 1; // Volume normal para garantir que toque
                audioCache.set(audioKey, audio);
                
                await new Promise((resolve) => {
                    audio.oncanplaythrough = resolve;
                    audio.onerror = resolve;
                    audio.load();
                });
            }
        } catch (error) {
            console.warn('Erro ao pré-carregar áudio:', audioKey, error);
        }
    }
}

// Configurar event listeners
function setupEventListeners() {
    recordButton.addEventListener('click', toggleRecording);
    
    recordButton.addEventListener('mouseenter', () => {
        if (!isRecording) recordButton.style.transform = 'translateY(-2px)';
    });
    
    recordButton.addEventListener('mouseleave', () => {
        if (!isRecording) recordButton.style.transform = 'translateY(0)';
    });
}

// Verificar permissão do microfone
async function checkMicrophonePermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        console.log('Permissão do microfone concedida');
    } catch (error) {
        console.error('Erro ao acessar microfone:', error);
        await speakText('Erro: Permissão do microfone necessária para usar o aplicativo.');
    }
}

// Função interna para reproduzir áudio diretamente (usada pela fila)
async function playAudioDirect(audioKey, speed = 1.0) {
    if (isMuted) return;
    
    try {
        let audio = audioCache.get(audioKey);
        
        if (!audio) {
            const audioFile = AUDIO_FILES[audioKey];
            if (!audioFile) {
                console.error('Arquivo de áudio não encontrado:', audioKey);
                if (audioKey === 'reminderDays') {
                    await speakText('Quais dias da semana deseja repetir? Diga: segunda, terça, quarta, quinta, sexta, sábado ou domingo.');
                    return;
                }
                return;
            }
            
            audio = new Audio(`${CONFIG.audioPath}${audioFile}`);
            audio.volume = 1;
            audio.playbackRate = speed;
            audio.preload = 'auto';
            audioCache.set(audioKey, audio);
        }
        
        // Parar qualquer áudio que esteja tocando
        if (currentPlayingAudio) {
            currentPlayingAudio.pause();
            currentPlayingAudio.currentTime = 0;
        }
        
        const audioClone = audio.cloneNode();
        audioClone.volume = 1;
        audioClone.playbackRate = speed;
        currentPlayingAudio = audioClone;
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                console.warn('Timeout na reprodução do áudio:', audioKey);
                if (currentPlayingAudio === audioClone) {
                    currentPlayingAudio = null;
                }
                resolve();
            }, 30000); // 30 segundos timeout
            
            audioClone.onended = () => {
                clearTimeout(timeout);
                if (currentPlayingAudio === audioClone) {
                    currentPlayingAudio = null;
                }
                resolve();
            };
            
            audioClone.onerror = (error) => {
                clearTimeout(timeout);
                console.error('Erro ao reproduzir áudio:', error);
                if (currentPlayingAudio === audioClone) {
                    currentPlayingAudio = null;
                }
                reject(error);
            };
            
            // Tentar reproduzir imediatamente
            const playPromise = audioClone.play();
            
            if (playPromise !== undefined) {
                playPromise
                    .then(() => {
                        console.log(`Áudio ${audioKey} reproduzido com sucesso`);
                    })
                    .catch(error => {
                        clearTimeout(timeout);
                        console.error('Erro ao iniciar reprodução:', error);
                        // Se falhar por autoplay, tentar carregar primeiro
                        if (error.name === 'NotAllowedError' || error.name === 'NotSupportedError') {
                            audioClone.load();
                            audioClone.oncanplaythrough = () => {
                                audioClone.play().catch(err => {
                                    console.error('Erro ao reproduzir após carregar:', err);
                                    if (currentPlayingAudio === audioClone) {
                                        currentPlayingAudio = null;
                                    }
                                    reject(err);
                                });
                            };
                        } else {
                            if (currentPlayingAudio === audioClone) {
                                currentPlayingAudio = null;
                            }
                            reject(error);
                        }
                    });
            } else {
                // Fallback para navegadores antigos
                if (audioClone.readyState >= 2) {
                    audioClone.play().catch(error => {
                        clearTimeout(timeout);
                        console.error('Erro ao iniciar reprodução:', error);
                        if (currentPlayingAudio === audioClone) {
                            currentPlayingAudio = null;
                        }
                        reject(error);
                    });
                } else {
                    audioClone.oncanplaythrough = () => {
                        audioClone.play().catch(error => {
                            clearTimeout(timeout);
                            console.error('Erro ao iniciar reprodução:', error);
                            if (currentPlayingAudio === audioClone) {
                                currentPlayingAudio = null;
                            }
                            reject(error);
                        });
                    };
                    audioClone.load();
                }
            }
        });
    } catch (error) {
        console.error('Erro na reprodução de áudio:', error);
        currentPlayingAudio = null;
    }
}

// Função pública para reproduzir áudio (usa fila)
async function playAudio(audioKey, speed = 1.0) {
    if (isMuted) return;
    return await queueAudio(audioKey, speed);
}

// Função para reproduzir áudio com velocidade otimizada
async function playAudioFast(audioKey) {
    console.log(`Tentando reproduzir áudio: ${audioKey}`);
    try {
        await playAudio(audioKey, 1.2); // 20% mais rápido
        console.log(`Áudio ${audioKey} reproduzido com sucesso`);
    } catch (error) {
        console.error(`Erro ao reproduzir áudio ${audioKey}:`, error);
        await speakText('Erro ao reproduzir áudio. Por favor, tente novamente.');
    }
}

// NOVO: Função para falar um prompt, mudar o estado e reiniciar a escuta (gravação)
async function speakAndStartListening(audioKey, fallbackText, newState) {
    currentConversationState = newState;
    
    // 1. Falar o prompt (tentando áudio pré-gravado, senão TTS)
    try { await playAudioFast(audioKey); } catch (error) { await speakText(fallbackText); }
    
    // 2. Reiniciar a gravação para o usuário responder no novo estado
    await startRecording(); 
}

// Mensagem de boas-vindas (mantida)
async function speakWelcomeMessage() {
    currentConversationState = 'welcome';
    try {
        await playAudio('welcome', 1.4);
        setTimeout(async () => {
            await speakOptions();
        }, 2000);
    } catch (e) {
        throw e;
    }
}

// Função para falar opções disponíveis (mantida)
async function speakOptions() {
    currentConversationState = 'listening';
    console.log('Sistema aguardando comando do usuário...');
}

// Alternar gravação
// Alternar gravação - AGORA CHAMA stopSpeaking() PRIMEIRO
async function toggleRecording() {
    // NOVO: Interrompe qualquer fala do sistema assim que o usuário clica
    stopSpeaking(); 

    if (isRecording) {
        stopRecording();
    } else {
        await startRecording();
    }
}

// Iniciar gravação - AGORA COM SPEECH RECOGNITION INTEGRADO
// Iniciar gravação - AGORA É ASYNC
async function startRecording() {
    // Evitar iniciar múltiplas gravações simultâneas
    if (isRecording) {
        console.log('Gravação já em andamento, ignorando nova tentativa.');
        return;
    }
    
    console.log('Iniciando gravação... Estado atual:', currentConversationState);
    try {
        updateStatus('🔴', 'recording');
        
        // Tocar áudio "listening" e aguardar terminar completamente
        await playAudioFast('listening');
        console.log('Áudio "listening" reproduzido, aguardando fala do usuário.');
        
        // Delay maior para garantir que o áudio terminou completamente e não interfere
        await new Promise(resolve => setTimeout(resolve, 1000));

        currentStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                sampleRate: 44100,
                autoGainControl: true
            } 
        });
        
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.error('SpeechRecognition não suportado pelo navegador.');
            await speakText('Erro: Seu navegador não suporta reconhecimento de fala avançado.');
            resetRecordingState();
            return;
        }

        // Criar NOVA instância do SpeechRecognition (garantir que é limpa)
        recognition = new SpeechRecognition();
        recognition.interimResults = false;
        recognition.lang = 'pt-BR';
        recognition.continuous = false;
        recognition.maxAlternatives = 1;

        // Registrar timestamp de quando a gravação começou
        recordingStartTime = Date.now();
        const expectedState = currentConversationState; // Guardar estado esperado

        recognition.onresult = (event) => {
            // Verificar se ainda estamos no estado esperado
            if (currentConversationState !== expectedState) {
                console.log(`⚠️ Estado mudou de ${expectedState} para ${currentConversationState}. Ignorando resultado anterior.`);
                return;
            }
            
            const last = event.results.length - 1;
            const spokenText = event.results[last][0].transcript.trim();
            console.log(`🗣️ Fala reconhecida: ${spokenText} (Estado: ${currentConversationState}, Estado esperado: ${expectedState})`);
            
            // Verificar timestamp novamente
            if (recordingStartTime) {
                const timeSinceStart = Date.now() - recordingStartTime;
                console.log(`⏱️ Tempo desde início da gravação: ${timeSinceStart}ms`);
            }
            
            processRecognizedText(spokenText);
        };

        recognition.onerror = async (event) => {
            console.error('Erro no SpeechRecognition:', event.error);
            
            // Se o erro for "no-speech", não fazer nada (usuário pode estar pensando)
            if (event.error === 'no-speech') {
                console.log('Nenhuma fala detectada. Aguardando...');
                // Não fazer nada, apenas encerrar silenciosamente
                await stopRecording();
                resetRecordingState();
                return;
            }
            
            // Se foi abortado, não fazer nada (já foi limpo)
            if (event.error === 'aborted') {
                console.log('Reconhecimento abortado (normal).');
                return;
            }
            
            // Para outros erros, pedir para repetir
            if (event.error !== 'network') {
                await stopRecording();
                await playAudioFast('repeat');
                // Reiniciar gravação após pedir para repetir
                setTimeout(async () => {
                    if (currentConversationState !== 'welcome' && !isRecording) {
                        await startRecording();
                    }
                }, 2000);
            }
            resetRecordingState();
        };
        
        recognition.onend = () => {
            console.log('Reconhecimento de fala encerrado.');
            // Limpar timestamp
            recordingStartTime = null;
            if (isRecording) {
                stopRecording();
            }
        };

        // Aguardar um pouco antes de iniciar para garantir que tudo está limpo
        await new Promise(resolve => setTimeout(resolve, 200));
        
        recognition.start();
        isRecording = true;
        recordButton.classList.add('recording');
        console.log('Gravação iniciada com sucesso.');

        setTimeout(() => {
            if (isRecording && recognition) {
                console.log('Timeout de gravação atingido.');
                recognition.stop();
            }
        }, CONFIG.maxRecordingTime);
        
    } catch (error) {
        console.error('Erro ao iniciar gravação:', error);
        await playAudioFast('repeat');
        resetRecordingState();
    }
}

function stopSpeaking() {
    // Parar todos os áudios e TTS
    stopAllAudios();
    console.log('Todos os áudios e TTS interrompidos.');
}
// Parar gravação (Simplificado, focando só no reconhecimento)
function stopRecording() {
    console.log('🛑 Parando gravação...');
    
    // Parar e limpar SpeechRecognition completamente
    if (recognition) {
        try {
            if (recognition.active) {
                recognition.abort(); // Usar abort ao invés de stop para garantir que pare imediatamente
            }
        } catch (e) {
            console.warn('Erro ao parar recognition:', e);
        }
        // Limpar event listeners antes de descartar
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition = null;
    }
    
    // Parar stream de microfone
    if (currentStream) {
        currentStream.getTracks().forEach(track => {
            track.stop();
            track.enabled = false;
        });
        currentStream = null;
    }
    
    // Limpar estados de gravação
    isRecording = false;
    mediaRecorder = null; // Não é mais usado na lógica principal
    audioChunks = [];     // Não é mais usado na lógica principal
    recordingStartTime = null; // Limpar timestamp
    
    recordButton.classList.remove('recording');
    recordButton.querySelector('.button-icon').textContent = '🎤';
    
    updateStatus('🎤', 'ready');
    
    // Pequeno delay para garantir que tudo foi limpo
    return new Promise(resolve => setTimeout(resolve, 300));
}

// Processar gravação (Agora chama o processamento de texto)
// Processar gravação (Agora chamado apenas como fallback se onresult não disparar)
async function processRecording() {
    // Se processRecording for chamado, significa que o onresult (que chama processRecognizedText) não foi acionado
    console.log("Processamento de gravação iniciado (Fallback/Timeout).");
    
    // Como não temos texto, voltamos ao estado de escuta de comando principal, tocando o áudio de repetição
    await playAudioFast('repeat');
    
    // Reinicia o ciclo no estado de escuta de comando
    currentConversationState = 'listening'; 
    
    resetRecordingState();
}

// Função para processar o texto REAL do SpeechRecognition
async function processRecognizedText(text) {
    // Verificar se o texto foi capturado após o início desta gravação
    if (recordingStartTime) {
        const timeSinceStart = Date.now() - recordingStartTime;
        // Se o texto foi capturado muito rápido (< 500ms), pode ser resultado anterior
        if (timeSinceStart < 500) {
            console.log(`⚠️ Texto capturado muito rápido (${timeSinceStart}ms), pode ser resultado anterior. Ignorando...`);
            return;
        }
    }
    
    // 1. Parar gravação completamente
    await stopRecording(); 
    
    // 2. Atualizar o estado visual
    updateStatus('⏳', 'processing'); 
    
    // 3. Gerenciar o fluxo de conversação baseado no texto
    await handleConversationFlowIntentFromText(text);
    
    // 4. O reset é chamado ao final de cada passo ou em 'saveReminder'
}

// Frases conhecidas do sistema que devem ser ignoradas
const SYSTEM_PHRASES = [
    'por favor diga',
    'por favor, diga',
    'que dia gostaria',
    'que horas gostaria',
    'qual nome',
    'este é um lembrete',
    'quais dias da semana',
    'me diga o nome',
    'não entendi',
    'estou ouvindo',
    'bem-vindo',
    'por favor repita'
];

// Função para filtrar frases do sistema (menos restritiva)
function filterSystemPhrases(text) {
    if (!text || text.trim().length === 0) {
        return null;
    }
    
    const lowerText = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    
    // Verificar se o texto é APENAS uma frase do sistema (sem conteúdo adicional)
    for (const phrase of SYSTEM_PHRASES) {
        // Se o texto é exatamente igual ou muito similar a uma frase do sistema
        if (lowerText === phrase || lowerText.startsWith(phrase + ' ') || lowerText === phrase.replace(/,/g, '')) {
            console.log(`⚠️ Filtrado: texto é apenas frase do sistema: "${text}"`);
            return null;
        }
        
        // Se começa com frase do sistema, tentar extrair a parte útil
        if (lowerText.startsWith(phrase)) {
            const afterPhrase = text.substring(phrase.length).trim();
            if (afterPhrase.length > 2) { // Se tem conteúdo útil após a frase
                console.log(`✅ Extraído após frase do sistema: "${afterPhrase}"`);
                return afterPhrase;
            }
        }
    }
    
    // Se passou por todas as verificações, retornar o texto original
    console.log(`✅ Texto aceito: "${text}"`);
    return text;
}

// Função que contém a lógica de I.A. (Intenção e Preenchimento)
async function handleConversationFlowIntentFromText(text) {
    console.log(`🔍 Processando texto recebido: "${text}" (Estado: ${currentConversationState})`);
    
    // Filtrar frases do sistema ANTES de processar (mas menos restritivo)
    const filteredText = filterSystemPhrases(text);
    
    if (!filteredText || filteredText.trim().length === 0) {
        console.log('⚠️ Texto filtrado ou vazio, mas tentando processar mesmo assim...');
        // Se o texto original tem conteúdo, usar ele mesmo (filtro pode ter sido muito restritivo)
        if (text && text.trim().length > 0 && text.trim().length < 100) {
            console.log('✅ Usando texto original apesar do filtro');
            const originalText = text.trim();
            
            // Continuar processamento com texto original
            const lowerText = originalText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            
            // Processar normalmente com texto original
            if (currentConversationState === 'reminder_name') {
                await handleConversationFlow('reminder_name', { name: originalText });
                return;
            }
            if (currentConversationState === 'reminder_date') {
                await handleConversationFlow('reminder_date', { date: originalText });
                return;
            }
            if (currentConversationState === 'reminder_time') {
                await handleConversationFlow('reminder_time', { time: originalText });
                return;
            }
            if (currentConversationState === 'reminder_days') {
                await handleConversationFlow('reminder_days', { repeatDays: [originalText] });
                return;
            }
            if (currentConversationState === 'edit_reminder_name') {
                await handleConversationFlow('edit_reminder_name', { name: originalText });
                return;
            }
            if (currentConversationState === 'delete_reminder_name') {
                await handleConversationFlow('delete_reminder_name', { name: originalText });
                return;
            }
            
            // Se não foi processado, reiniciar gravação
            if (currentConversationState !== 'welcome' && currentConversationState !== 'listening') {
                await startRecording();
            }
        }
        return;
    }
    
    // Usar texto filtrado
    const lowerText = filteredText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // --- 1. INTENÇÕES PRINCIPAIS (Estado 'listening') ---
    if (currentConversationState === 'listening') {
        if (lowerText.includes('criar')) {
            console.log('Intenção "criar lembrete" detectada. Mudando para estado reminder_name.');
            await handleConversationFlow('create_reminder', {});
        } else if (lowerText.includes('editar')) {
            await handleConversationFlow('edit_reminder', {});
        } else if (lowerText.includes('excluir') || lowerText.includes('remover')) {
            await handleConversationFlow('delete_reminder', {});
        } else if (lowerText.includes('listar') || lowerText.includes('ver')) {
            await handleConversationFlow('list_reminders', {});
        } else {
            await playAudioFast('repeat'); 
        }
        return;
    }
    
    // --- 2. FLUXO DE PREENCHIMENTO (Usa o texto EXATO reconhecido) ---
    let handled = false;
    
    if (currentConversationState === 'reminder_name') {
        await handleConversationFlow('reminder_name', { name: filteredText }); // Texto EXATO
        handled = true;
    }
    
    if (currentConversationState === 'reminder_date') {
        await handleConversationFlow('reminder_date', { date: filteredText }); // Texto EXATO para normalização
        handled = true;
    }
    
    if (currentConversationState === 'reminder_time') {
        await handleConversationFlow('reminder_time', { time: filteredText }); // Texto EXATO para normalização
        handled = true;
    }
    
    if (currentConversationState === 'reminder_repeat') {
        const repeat = lowerText.includes('sim') || lowerText.includes('quero') || lowerText.includes('repetir');
        await handleConversationFlow('reminder_repeat', { repeat: repeat });
        handled = true;
    }
    
    if (currentConversationState === 'reminder_days') {
        // Capturar texto EXATO, mas normalizar para o formato padrão
        await handleConversationFlow('reminder_days', { repeatDays: [filteredText] }); // Array com texto exato
        handled = true;
    }
    
    // Fluxos de Edição/Exclusão
    if (currentConversationState === 'edit_reminder_name') {
        await handleConversationFlow('edit_reminder_name', { name: filteredText }); // Texto EXATO
        handled = true;
    }
    
    if (currentConversationState === 'delete_reminder_name') {
        await handleConversationFlow('delete_reminder_name', { name: filteredText }); // Texto EXATO
        handled = true;
    }

    if (!handled && currentConversationState !== 'welcome') {
        await playAudioFast('repeat');
        console.log(`Comando não reconhecido no estado ${currentConversationState}. Mantendo o estado.`);
    }
}


// Função para gerenciar o fluxo da conversa (revisada para ÁUDIO FIRST)
async function handleConversationFlow(intent, data) {
    switch (intent) {
        case 'create_reminder':
    currentReminderData = {}; // Resetar dados do lembrete
    currentConversationState = 'reminder_name'; // Atualizar estado
    try {
        await playAudioFast('reminderName');
        await startRecording(); // Iniciar gravação para capturar o nome
    } catch (error) {
        console.error('Erro ao processar create_reminder:', error);
        await speakText('Erro ao criar lembrete. Por favor, tente novamente.');
        currentConversationState = 'welcome'; // Voltar ao estado inicial em caso de erro
        await startRecording(); // Tentar reiniciar a gravação
    }
    break;
            
        case 'edit_reminder':
            try { await playAudioFast('editReminder'); } catch (error) { await speakText('Me diga o nome do lembrete que deseja editar'); }
            currentConversationState = 'edit_reminder_name';
            await startRecording(); // Capturar o nome a ser editado
            break;
            
        case 'delete_reminder':
            try { await playAudioFast('deleteReminder'); } catch (error) { await speakText('Me diga o nome do lembrete que deseja excluir'); }
            currentConversationState = 'delete_reminder_name';
            await startRecording(); // Capturar o nome a ser excluído
            break;
            
        case 'edit_reminder_name':
            currentEditData = { name: data.name };
            console.log('📝 Usuário deseja editar lembrete:', currentEditData);
            // Mantemos apenas armazenamento/local log; backend será integrado depois
            currentConversationState = 'welcome';
            setTimeout(() => { speakWelcomeMessage(); }, 1000);
            break;
            
        case 'delete_reminder_name':
            currentDeleteData = { name: data.name };
            console.log('🗑️ Usuário deseja excluir lembrete:', currentDeleteData);
            // Apenas armazenamento/local log por enquanto
            currentConversationState = 'welcome';
            setTimeout(() => { speakWelcomeMessage(); }, 1000);
            break;
            
        case 'reminder_name':
            // Armazenar EXATAMENTE como foi dito (sem normalizar)
            currentReminderData.name = data.name.trim();
            console.log('✅ Nome capturado (exato):', currentReminderData.name);
            // PRÓXIMO: DATA
            try { 
                await playAudioFast('reminderDate'); 
            } catch (error) { 
                await speakText('Que dia gostaria de ser lembrado?'); 
            }
            // Aguardar áudio terminar antes de iniciar gravação
            currentConversationState = 'reminder_date';
            await startRecording(); // Iniciar gravação após áudio terminar
            break;
            
        case 'reminder_date':
            // Armazenar texto EXATO primeiro
            currentReminderData.dateRaw = data.date.trim();
            console.log('📝 Data capturada (exata):', currentReminderData.dateRaw);
            
            // Normalizar para formato padrão
            currentReminderData.date = normalizeDatePt(data.date);
            if (!currentReminderData.date || !currentReminderData.date.match(/\d{4}-\d{2}-\d{2}/)) {
                 await speakText('Não entendi a data. Por favor, diga o dia e o mês, como: "Dia quatro de dezembro".');
                 currentConversationState = 'reminder_date'; // Repete o estado
                 // Aguardar TTS terminar e reiniciar gravação
                 await startRecording();
                 return;
            }
            
            console.log('✅ Data normalizada:', currentReminderData.date);
            // PRÓXIMO: HORA
            try { 
                await playAudioFast('reminderTime'); 
            } catch (error) { 
                await speakText('Que horas gostaria de ser lembrado?'); 
            }
            currentConversationState = 'reminder_time';
            await startRecording(); // Iniciar gravação após áudio terminar
            break;
            
        case 'reminder_time':
            // Armazenar texto EXATO primeiro
            currentReminderData.timeRaw = data.time.trim();
            console.log('📝 Hora capturada (exata):', currentReminderData.timeRaw);
            
            // Normalizar para formato padrão
            currentReminderData.time = normalizeTimePt(data.time);
            if (!currentReminderData.time || !currentReminderData.time.match(/\d{2}:\d{2}/)) {
                 await speakText('Não entendi a hora. Por favor, diga a hora com clareza, como: "oito horas da manhã" ou "vinte horas".');
                 currentConversationState = 'reminder_time'; // Repete o estado
                 // Aguardar TTS terminar e reiniciar gravação
                 await startRecording();
                 return;
            }
            
            console.log('✅ Hora normalizada:', currentReminderData.time);
            // PRÓXIMO: REPETIÇÃO
            try { 
                await playAudioFast('reminderRepeat'); 
            } catch (error) { 
                await speakText('Este é um lembrete que gostaria de repetir?'); 
            }
            currentConversationState = 'reminder_repeat';
            await startRecording(); // Iniciar gravação após áudio terminar
            break;
            
        case 'reminder_repeat':
            currentReminderData.repeat = data.repeat;
            console.log('✅ Repetir capturado:', data.repeat);
            
            if (data.repeat === true) {
                // PRÓXIMO: DIAS DA SEMANA
                try { 
                    await playAudioFast('reminderDays'); 
                } catch (error) { 
                    await speakText('Quais dias da semana deseja repetir? Diga: segunda, terça, quarta, quinta, sexta, sábado ou domingo.'); 
                }
                currentConversationState = 'reminder_days';
                await startRecording(); // Iniciar gravação após áudio terminar
            } else {
                await saveReminder();
            }
            break;
        
        case 'reminder_days':
            // Armazenar texto EXATO primeiro
            const daysText = Array.isArray(data.repeatDays) ? data.repeatDays.join(' ') : data.repeatDays;
            currentReminderData.repeatDaysRaw = daysText.trim();
            console.log('📝 Dias capturados (exatos):', currentReminderData.repeatDaysRaw);
            
            // Normalizar para formato padrão
            const daysArray = Array.isArray(data.repeatDays) ? data.repeatDays : [data.repeatDays];
            currentReminderData.repeatDays = normalizeWeekdaysPt(daysArray);
            
            if (currentReminderData.repeatDays.length === 0) {
                 await speakText('Não entendi os dias. Por favor, diga os dias que deseja, como: "segunda e quarta".');
                 currentConversationState = 'reminder_days'; // Repete o estado
                 // Aguardar TTS terminar e reiniciar gravação
                 await startRecording();
                 return;
            }
            
            console.log('✅ Dias normalizados:', currentReminderData.repeatDays);
            await saveReminder();
            break;
            
        case 'list_reminders':
            console.log('📋 Usuário deseja listar lembretes (lógica será implementada no backend).');
            currentConversationState = 'welcome';
            setTimeout(() => { speakWelcomeMessage(); }, 1000);
            break;
            
        default:
            await playAudioFast('repeat');
            break;
    }
    console.log('📝 JSON atual:', JSON.stringify(currentReminderData, null, 2));
}

// Função para validar se lembrete está completo
function isReminderComplete() {
    const required = ['name', 'date', 'time', 'repeat'];
    const hasRequired = required.every(field => currentReminderData[field] !== undefined);
    
    if (currentReminderData.repeat === true) {
        return hasRequired && Array.isArray(currentReminderData.repeatDays) && currentReminderData.repeatDays.length > 0;
    }
    
    return hasRequired;
}

// Função para salvar lembrete completo
async function saveReminder() {
    if (!isReminderComplete()) {
        console.log('❌ Lembrete incompleto, aguardando mais informações:', currentReminderData);
        await speakText('Ainda faltam informações. Por favor, complete todos os dados do lembrete.');
        return;
    }
    
    // MOCK: Exibe o JSON final
    console.log('=== JSON COMPLETO PARA BACKEND ===');
    console.log(JSON.stringify(currentReminderData, null, 2));
    console.log('=== FIM DO JSON ===');
    await speakText(`Seu lembrete ${currentReminderData.name} foi criado para o dia ${currentReminderData.date} às ${currentReminderData.time}.`);
    
    // Resetar estado
    currentConversationState = 'welcome';
    currentReminderData = {};
}

// Função para listar lembretes (Mock)
async function listReminders() {
    await speakText('Nenhum lembrete encontrado, pois a funcionalidade de listagem do servidor não foi implementada.');
    currentConversationState = 'welcome';
}

// Resetar estado da gravação
function resetRecordingState() {
    isRecording = false;
    mediaRecorder = null;
    audioChunks = [];
    currentStream = null;
    
    recordButton.classList.remove('recording');
    recordButton.querySelector('.button-icon').textContent = '🎤';
    
    updateStatus('🎤', 'ready');
}

// Atualizar status
function updateStatus(text, type = 'ready') {
    statusIndicator.querySelector('.status-text').textContent = text;
    statusIndicator.className = `status-indicator ${type}`;
}

// Mostrar feedback (minimalista)
function showFeedback(message, type = 'info') {
    feedbackText.textContent = message;
    feedbackText.className = `feedback-text ${type}`;
    
    setTimeout(() => {
        feedbackText.textContent = '';
        feedbackText.className = 'feedback-text';
    }, 3000);
}


// Desbloqueio de áudio no primeiro gesto do usuário
function setupAudioUnlockOnce() {
    const unlockAndGreet = async () => {
        if (isFirstTime) {
            try {
                console.log('Desbloqueando áudio no primeiro gesto...');
                // Aguardar um pouco para garantir que o contexto de áudio está desbloqueado
                await new Promise(resolve => setTimeout(resolve, 100));
                await speakWelcomeMessage();
                isFirstTime = false;
            } catch (e) {
                console.log('Erro ao tocar boas-vindas após desbloqueio:', e);
                // Fallback para TTS
                await speakText(
                    'Bem-vindo ao sistema Memorae, sua agenda de lembretes. ' +
                    'Diga "criar lembrete", "editar lembrete", "excluir lembrete", ou "ver lembretes".'
                );
                isFirstTime = false;
            } finally {
                document.removeEventListener('click', unlockAndGreet);
                document.removeEventListener('touchstart', unlockAndGreet);
                document.removeEventListener('keydown', unlockAndGreet);
            }
        }
    };
    
    if (isFirstTime) {
        // Adicionar listener no botão de gravação também
        recordButton.addEventListener('click', unlockAndGreet, { once: true });
        document.addEventListener('click', unlockAndGreet, { once: true });
        document.addEventListener('touchstart', unlockAndGreet, { once: true });
        document.addEventListener('keydown', unlockAndGreet, { once: true });
    }
}

// =========================
// Normalização PT-BR -> ISO
// =========================
function normalizeTimePt(input) {
    if (!input) return input;
    let text = String(input).toLowerCase().trim();
    
    const timeMatch = text.match(/(\d{1,2})\s*(?:horas?|h)\s*(?:e\s*(\d{1,2})\s*(?:minutos?|min))?/);
    if (timeMatch) {
        let hour = parseInt(timeMatch[1], 10);
        let minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        
        hour = Math.max(0, Math.min(23, hour));
        minute = Math.max(0, Math.min(59, minute));
        
        const hh = String(hour).padStart(2, '0');
        const mm = String(minute).padStart(2, '0');
        return `${hh}:${mm}`;
    }
    
    text = text
        .replace(/\s+/g, ' ')
        .replace(/da\s*manhã|da\s*manha/gi, 'manha')
        .replace(/da\s*noite/gi, 'noite')
        .replace(/da\s*tarde/gi, 'tarde')
        .trim();

    const match = text.match(/(\d{1,2})(?:[:h](\d{1,2}))?/);
    if (!match) return input;
    let hour = parseInt(match[1], 10);
    let minute = match[2] ? parseInt(match[2], 10) : 0;

    const hasManha = /manha/.test(text);
    const hasTarde = /tarde/.test(text);
    const hasNoite = /noite/.test(text);

    if (hasManha) {
        if (hour === 12) hour = 0;
        if (hour > 23) hour = hour % 24;
    } else if (hasTarde || hasNoite) {
        if (hour >= 1 && hour <= 11) hour += 12;
        if (hour > 23) hour = hour % 24;
    } else {
        if (hour > 23) hour = hour % 24;
    }

    const hh = String(Math.max(0, Math.min(23, hour))).padStart(2, '0');
    const mm = String(Math.max(0, Math.min(59, minute))).padStart(2, '0');
    return `${hh}:${mm}`;
}

function normalizeDatePt(input) {
    if (!input) return null;
    const text = String(input).toLowerCase().trim();
    const now = new Date();
    
    const monthMap = {
        'janeiro': 1, 'fevereiro': 2, 'março': 3, 'marco': 3, 'abril': 4, 'maio': 5, 'junho': 6,
        'julho': 7, 'agosto': 8, 'setembro': 9, 'outubro': 10, 'novembro': 11, 'dezembro': 12
    };
    
    // Normalizar texto (remover acentos e caracteres especiais)
    const normalizedText = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    // Padrão melhorado: captura "4 de dezembro", "dia 4 de dezembro", "4 dezembro", etc.
    // Primeiro tenta padrão com "de" entre número e mês (sem acentos)
    let dayMatch = normalizedText.match(/(?:dia\s*)?(\d{1,2})\s*de\s*(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/);
    
    if (!dayMatch) {
        // Se não encontrou com "de", tenta sem "de"
        dayMatch = normalizedText.match(/(?:dia\s*)?(\d{1,2})\s+(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/);
    }
    
    // Se ainda não encontrou, tenta com o texto original (com acentos)
    if (!dayMatch) {
        dayMatch = text.match(/(?:dia\s*)?(\d{1,2})\s*de\s*(janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/);
    }
    
    if (!dayMatch) {
        dayMatch = text.match(/(?:dia\s*)?(\d{1,2})\s+(janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/);
    }
    
    if (dayMatch) {
        const day = parseInt(dayMatch[1], 10);
        const monthNameOriginal = dayMatch[2].toLowerCase();
        // Normalizar nome do mês para a versão sem acento
        const monthName = monthNameOriginal.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const monthValue = monthMap[monthName] || monthMap[monthNameOriginal];
        
        if (monthValue === undefined || monthValue < 1 || monthValue > 12) {
            console.warn('Mês não reconhecido:', monthNameOriginal, monthName);
            return null;
        }
        
        // Converter para índice do Date (0-11)
        const monthIndex = monthValue - 1;
        
        let year = now.getFullYear();
        let date = new Date(year, monthIndex, day);
        
        // Se a data já passou este ano, usar próximo ano
        if (date < now && (monthIndex <= now.getMonth())) {
            date = new Date(year + 1, monthIndex, day);
            year = year + 1;
        }
        
        // Validar se a data é válida
        if (date.getDate() !== day || date.getMonth() !== monthIndex) {
            console.warn('Data inválida:', day, monthName);
            return null;
        }
        
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        console.log(`✅ Data normalizada: "${input}" → ${yyyy}-${mm}-${dd}`);
        return `${yyyy}-${mm}-${dd}`;
    }
    
    // Fallback para "hoje"
    if (text.includes('hoje')) {
        const d = new Date(now);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    
    // Fallback para "amanhã"
    if (text.includes('amanhã') || text.includes('amanha')) {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    
    console.warn('Não foi possível normalizar a data:', input);
    return null;
}

function normalizeWeekdaysPt(list) {
    if (!Array.isArray(list)) return [];
    const map = {
        'segunda': 'monday', 'segunda-feira': 'monday',
        'terca': 'tuesday', 'terça': 'tuesday', 'terça-feira': 'tuesday', 'terca-feira': 'tuesday',
        'quarta': 'wednesday', 'quarta-feira': 'wednesday',
        'quinta': 'thursday', 'quinta-feira': 'thursday',
        'sexta': 'friday', 'sexta-feira': 'friday',
        'sabado': 'saturday', 'sábado': 'saturday',
        'domingo': 'sunday'
    };
    const normalized = [];
    
    const combinedText = list.join(', ').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const words = combinedText.split(/\s|e|,/);
    
    for (const word of words) {
        if (!word) continue;
        const trimmedWord = word.trim();
        
        const value = map[trimmedWord];
        if (value && !normalized.includes(value)) {
            normalized.push(value);
        }
    }
    return normalized;
}

// Inicializar após o DOM carregar
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    checkMicrophonePermission();
    initializeApp();
});