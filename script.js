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
let lastProcessedText = null; // Último texto processado para evitar reprocessamento
let lastProcessedState = null; // Último estado em que processamos texto
let microphonePermissionGranted = false; // Rastrear se a permissão já foi concedida
let microphonePermissionChecked = false; // Rastrear se já verificamos a permissão

// Sistema de fila de áudios para evitar sobreposição
let audioQueue = [];
let isPlayingAudio = false;
let currentPlayingAudio = null;

// Função para adicionar áudio à fila
async function queueAudio(audioKey, speed = 1.0) {
    return new Promise((resolve, reject) => {
        audioQueue.push({ audioKey, speed, resolve, reject });
        processAudioQueue();
    });
}

// Função para processar a fila de áudios
async function processAudioQueue() {
    if (isPlayingAudio || audioQueue.length === 0) return;
    
    isPlayingAudio = true;
    const { audioKey, speed, resolve, reject } = audioQueue.shift();
    
    try {
        await playAudioDirect(audioKey, speed);
        resolve();
    } catch (error) {
        console.error('Erro ao tocar áudio da fila:', error);
        // Se for erro de autoplay, rejeitar para que o chamador possa usar TTS
        if (error.name === 'NotAllowedError' || error.name === 'NotSupportedError') {
            if (reject) reject(error);
            else resolve(); // Se não houver reject, apenas resolver
        } else {
            resolve(); // Para outros erros, apenas resolver
        }
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
    // Não verificar permissão aqui novamente - já foi verificado no DOMContentLoaded

    // Configurar desbloqueio de áudio no primeiro clique
    setupAudioUnlockOnce();

    // Tentativa automática de reprodução com fallback TTS
    // Aguardar um pouco para garantir que o contexto de áudio está pronto
    setTimeout(async () => {
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
    }, 500);
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
    // Evitar verificar múltiplas vezes
    if (microphonePermissionChecked) {
        return microphonePermissionGranted;
    }
    
    microphonePermissionChecked = true;
    
    // Verificar se está em HTTPS (necessário para alguns navegadores)
    const isSecure = window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    if (!isSecure) {
        console.warn('⚠️ Aplicação rodando em HTTP. Alguns navegadores podem bloquear acesso ao microfone. Use HTTPS ou localhost.');
    }
    
    // Tentar verificar permissão usando Permissions API (se disponível)
    try {
        if (navigator.permissions && navigator.permissions.query) {
            const permissionStatus = await navigator.permissions.query({ name: 'microphone' });
            
            if (permissionStatus.state === 'granted') {
                console.log('✅ Permissão do microfone já concedida (verificado via Permissions API)');
                microphonePermissionGranted = true;
                return true;
            } else if (permissionStatus.state === 'denied') {
                console.error('❌ Permissão do microfone negada pelo usuário');
                microphonePermissionGranted = false;
                await speakText('Permissão do microfone foi negada. Por favor, permita o acesso nas configurações do navegador.');
                return false;
            }
            // Se for 'prompt', continuar para pedir permissão
        }
    } catch (e) {
        // Permissions API pode não estar disponível em todos os navegadores
        console.log('Permissions API não disponível, tentando acesso direto...');
    }
    
    // Se não temos certeza da permissão, tentar acessar o microfone
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        console.log('✅ Permissão do microfone concedida');
        microphonePermissionGranted = true;
        return true;
    } catch (error) {
        console.error('❌ Erro ao acessar microfone:', error);
        microphonePermissionGranted = false;
        
        let errorMessage = 'Erro ao acessar o microfone. ';
        
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            errorMessage += 'Permissão negada. Por favor, permita o acesso ao microfone nas configurações do navegador.';
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
            errorMessage += 'Nenhum microfone encontrado. Verifique se há um microfone conectado.';
        } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
            errorMessage += 'O microfone está sendo usado por outro aplicativo.';
        } else if (!isSecure) {
            errorMessage += 'Alguns navegadores exigem HTTPS para acesso ao microfone. Tente usar localhost ou configure HTTPS.';
        } else {
            errorMessage += 'Por favor, verifique as configurações do navegador.';
        }
        
        await speakText(errorMessage);
        return false;
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
                        // Se falhar por autoplay, lançar erro imediatamente para usar TTS
                        if (error.name === 'NotAllowedError' || error.name === 'NotSupportedError') {
                            if (currentPlayingAudio === audioClone) {
                                currentPlayingAudio = null;
                            }
                            // Lançar erro para que o chamador possa usar TTS
                            reject(error);
                        } else {
                            // Para outros erros, tentar carregar primeiro
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
    try {
        return await queueAudio(audioKey, speed);
    } catch (error) {
        // Se falhar por autoplay, lançar erro para que o chamador use TTS
        if (error.name === 'NotAllowedError' || error.name === 'NotSupportedError') {
            throw error;
        }
        // Para outros erros, apenas logar
        console.error('Erro ao reproduzir áudio:', error);
    }
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
        // Tentar tocar o áudio de boas-vindas
        await playAudio('welcome', 1.0);
        setTimeout(async () => {
            await speakOptions();
        }, 2000);
    } catch (e) {
        console.error('Erro ao tocar áudio de boas-vindas, usando TTS:', e);
        // Fallback para TTS se o áudio falhar (especialmente por autoplay)
        await speakText(
            'Bem-vindo ao sistema Memorae, sua agenda de lembretes. ' +
            'Diga "criar lembrete", "editar lembrete", "excluir lembrete", ou "ver lembretes".'
        );
        setTimeout(async () => {
            await speakOptions();
        }, 1000);
    }
}

// Função para falar opções disponíveis (mantida)
async function speakOptions() {
    // Só mudar o estado se não estiver gravando, para evitar conflito
    if (!isRecording) {
        currentConversationState = 'listening';
    }
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
    
    // Verificar permissão antes de tentar gravar (mas não pedir novamente se já foi negada)
    if (!microphonePermissionGranted && microphonePermissionChecked) {
        console.error('Permissão do microfone não concedida. Não é possível gravar.');
        await speakText('Permissão do microfone necessária. Por favor, recarregue a página e permita o acesso.');
        return;
    }
    
    // Garantir que qualquer recognition anterior foi completamente limpo
    if (recognition) {
        try {
            if (recognition.active || recognition.state === 'listening' || recognition.state === 'starting') {
                console.log('Limpando recognition anterior antes de iniciar nova gravação...');
                recognition.abort();
            }
        } catch (e) {
            console.warn('Erro ao limpar recognition anterior:', e);
        }
        // Limpar completamente
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition = null;
    }
    
    // Aguardar um pouco para garantir que tudo foi limpo
    await new Promise(resolve => setTimeout(resolve, 300));
    
    console.log('Iniciando gravação... Estado atual:', currentConversationState);
    try {
        updateStatus('🔴', 'recording');

        // Verificar se o stream atual ainda está ativo
        let streamActive = false;
        if (currentStream) {
            streamActive = currentStream.getTracks().some(track => track.readyState === 'live');
        }
        
        // Se não temos stream ativo, obter um novo
        if (!streamActive) {
            // Limpar stream antigo se existir
            if (currentStream) {
                currentStream.getTracks().forEach(track => track.stop());
                currentStream = null;
            }
            
            currentStream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 44100,
                    autoGainControl: true
                } 
            });
            // Marcar permissão como concedida se conseguirmos o stream
            microphonePermissionGranted = true;
            console.log('✅ Stream de microfone obtido com sucesso');
        } else {
            console.log('✅ Reutilizando stream de microfone existente');
        }
        
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
        recognition.continuous = false; // false para parar após detectar fala
        recognition.maxAlternatives = 1;

        // Registrar timestamp de quando a gravação começou
        recordingStartTime = Date.now();
        const expectedState = currentConversationState; // Guardar estado esperado

        recognition.onresult = (event) => {
            // Verificar se ainda estamos no estado esperado
            // Permitir transição de 'welcome' para 'listening' pois são estados equivalentes para capturar comandos
            const isStateTransitionValid = (expectedState === 'welcome' && currentConversationState === 'listening') ||
                                         (expectedState === 'listening' && currentConversationState === 'welcome') ||
                                         (currentConversationState === expectedState);
            
            if (!isStateTransitionValid) {
                console.log(`⚠️ Estado mudou de ${expectedState} para ${currentConversationState}. Ignorando resultado anterior.`);
                return;
            }
            
            // Se houve transição válida, atualizar o estado esperado para o atual
            if (currentConversationState !== expectedState) {
                console.log(`✅ Transição válida de ${expectedState} para ${currentConversationState}. Processando resultado.`);
            }
            
            const last = event.results.length - 1;
            const spokenText = event.results[last][0].transcript.trim();
            console.log(`🗣️ Fala reconhecida: ${spokenText} (Estado: ${currentConversationState}, Estado esperado: ${expectedState})`);
            
            // Verificar timestamp novamente
            if (recordingStartTime) {
                const timeSinceStart = Date.now() - recordingStartTime;
                console.log(`⏱️ Tempo desde início da gravação: ${timeSinceStart}ms`);
            }
            
            // Parar o recognition antes de processar para evitar múltiplos resultados
            if (recognition) {
                try {
                    recognition.stop();
                } catch (e) {
                    console.warn('Erro ao parar recognition:', e);
                }
            }
            
            processRecognizedText(spokenText);
        };

        recognition.onerror = async (event) => {
            console.error('Erro no SpeechRecognition:', event.error);
            
            // Se o erro for "no-speech", não fazer nada (usuário pode estar pensando)
            // NÃO parar a gravação - deixar o usuário tentar novamente
            if (event.error === 'no-speech') {
                console.log('Nenhuma fala detectada. Aguardando usuário clicar novamente no botão...');
                // Não fazer nada - deixar o usuário clicar no botão novamente
                isRecording = false;
                recordButton.classList.remove('recording');
                recordButton.querySelector('.button-icon').textContent = '🎤';
                updateStatus('🎤', 'ready');
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
            
            // Se ainda estamos gravando e não recebemos resultado, pode ser que o usuário não falou
            // NÃO parar automaticamente - deixar o usuário tentar novamente clicando no botão
            if (isRecording) {
                console.log('Reconhecimento encerrado sem resultado. Aguardando usuário clicar novamente no botão.');
                // Resetar estado visual mas não avançar no fluxo
                isRecording = false;
                recordButton.classList.remove('recording');
                recordButton.querySelector('.button-icon').textContent = '🎤';
                updateStatus('🎤', 'ready');
                // NÃO chamar stopRecording() para não limpar o stream - deixar o usuário controlar
            }
        };

        // Aguardar um pouco antes de iniciar para garantir que tudo está limpo
        await new Promise(resolve => setTimeout(resolve, 200));
        
        recognition.start();
        isRecording = true;
        recordButton.classList.add('recording');
        console.log('Gravação iniciada com sucesso.');
        
        // Tocar áudio "listening" APENAS quando a gravação realmente começar
        // Usar setTimeout para não bloquear e garantir que o recognition.start() foi processado
        setTimeout(async () => {
            try {
                await playAudioFast('listening');
                console.log('Áudio "listening" reproduzido após início da gravação.');
                // Marcar timestamp de quando o áudio "listening" terminou de tocar
                // Isso será usado para ignorar qualquer texto capturado logo após o áudio
                listeningAudioEndTime = Date.now();
            } catch (error) {
                console.warn('Erro ao tocar áudio "listening":', error);
                // Mesmo se houver erro, marcar o tempo para evitar problemas
                listeningAudioEndTime = Date.now();
            }
        }, 100);

        setTimeout(() => {
            if (isRecording && recognition) {
                console.log('Timeout de gravação atingido.');
                recognition.stop();
            }
        }, CONFIG.maxRecordingTime);
        
    } catch (error) {
        console.error('Erro ao iniciar gravação:', error);
        
        // Se for erro de permissão, marcar como negada
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            microphonePermissionGranted = false;
            await speakText('Permissão do microfone negada. Por favor, permita o acesso nas configurações do navegador e recarregue a página.');
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
            await speakText('Nenhum microfone encontrado. Verifique se há um microfone conectado.');
        } else {
            await playAudioFast('repeat');
        }
        
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
    listeningAudioEndTime = null; // Limpar timestamp do áudio "listening"
    // Não limpar lastProcessedText aqui - ele deve persistir entre gravações no mesmo estado
    
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

// Variável global para rastrear quando o áudio "listening" terminou de tocar
let listeningAudioEndTime = null;

// Função para processar o texto REAL do SpeechRecognition
async function processRecognizedText(text) {
    // Validar que o texto não está vazio ou muito curto
    if (!text || text.trim().length < 2) {
        console.log('⚠️ Texto muito curto ou vazio, ignorando...');
        return;
    }
    
    // Normalizar texto para comparação
    const normalizedText = text.trim().toLowerCase();
    
    // Verificar se este é o mesmo texto que foi processado no estado anterior
    // Isso evita reprocessar o mesmo texto quando mudamos de estado
    if (lastProcessedText && lastProcessedState && 
        lastProcessedState !== currentConversationState) {
        const lastProcessedNormalized = lastProcessedText.toLowerCase().trim();
        
        // Verificar se é exatamente o mesmo texto
        if (normalizedText === lastProcessedNormalized) {
            console.log(`⚠️ Texto duplicado do estado anterior ignorado: "${text}" (Estado anterior: ${lastProcessedState}, Estado atual: ${currentConversationState})`);
            return;
        }
        
        // Verificar se o texto atual contém o texto anterior (pode ser que tenha sido capturado com mais contexto)
        if (normalizedText.includes(lastProcessedNormalized) && lastProcessedNormalized.length > 5) {
            console.log(`⚠️ Texto atual contém texto do estado anterior, pode ser duplicado: "${text}" (Estado anterior: ${lastProcessedState}, Estado atual: ${currentConversationState})`);
            // Não retornar imediatamente, mas verificar se há conteúdo adicional significativo
            const additionalText = normalizedText.replace(lastProcessedNormalized, '').trim();
            if (additionalText.length < 3) {
                console.log(`⚠️ Texto duplicado confirmado, ignorando...`);
                return;
            }
        }
    }
    
    // Removida validação de tempo mínimo - usuários podem falar rapidamente
    
    // Verificar se o sistema está reproduzindo áudio (não processar se estiver)
    // EXCEÇÕES: Processar mesmo assim se:
    // 1. Estiver no estado reminder_repeat e o texto contém dias da semana
    // 2. Estiver no estado reminder_date e o texto contém informações de data (números, meses)
    const weekdays = ['segunda', 'terça', 'terca', 'quarta', 'quinta', 'sexta', 'sábado', 'sabado', 'domingo'];
    const containsWeekdays = currentConversationState === 'reminder_repeat' && 
                             weekdays.some(day => normalizedText.includes(day));
    
    // Verificar se contém informações de data (números e meses)
    const dateKeywords = ['janeiro', 'fevereiro', 'março', 'marco', 'abril', 'maio', 'junho', 
                         'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro', 
                         'hoje', 'amanha', 'amanhã', 'dia'];
    const containsDateInfo = currentConversationState === 'reminder_date' && 
                            (/\d/.test(normalizedText) || dateKeywords.some(keyword => normalizedText.includes(keyword)));
    
    // Verificar se contém informações de hora (números com "horas", "h", "minutos", etc)
    const timeKeywords = ['horas', 'hora', 'h', 'minutos', 'min', 'manhã', 'manha', 'tarde', 'noite'];
    const containsTimeInfo = currentConversationState === 'reminder_time' && 
                            (/\d/.test(normalizedText) || timeKeywords.some(keyword => normalizedText.includes(keyword)));
    
    const shouldProcessDespiteAudio = containsWeekdays || containsDateInfo || containsTimeInfo;
    
    if (!shouldProcessDespiteAudio && (isPlayingAudio || currentPlayingAudio) && recordingStartTime) {
        const timeSinceStart = Date.now() - recordingStartTime;
        // Se ainda está tocando áudio e passou menos de 5 segundos, ignorar
        // Aumentado para 5 segundos para garantir que o áudio terminou completamente
        if (timeSinceStart < 5000) {
            console.log('⚠️ Sistema está reproduzindo áudio, ignorando texto capturado para evitar eco.');
            return;
        }
    }
    
    // 1. Parar gravação completamente (garantir que está realmente parada)
    await stopRecording();
    // Aguardar um pouco para garantir que tudo foi limpo
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // 2. Atualizar o estado visual
    updateStatus('⏳', 'processing'); 
    
    // 3. Atualizar rastreamento do último texto processado
    lastProcessedText = text.trim();
    lastProcessedState = currentConversationState;
    
    // 4. Gerenciar o fluxo de conversação baseado no texto
    await handleConversationFlowIntentFromText(text);
    
    // 5. O reset é chamado ao final de cada passo ou em 'saveReminder'
}

// Frases conhecidas do sistema que devem ser ignoradas (apenas quando o texto é EXATAMENTE isso)
const SYSTEM_PHRASES = [
    'por favor diga',
    'por favor, diga',
    'por favor pode repetir',
    'por favor, pode repetir',
    'pode repetir',
    'que dia gostaria',
    'que horas gostaria',
    'qual nome',
    'este é um lembrete',
    'quais dias da semana',
    'me diga o nome',
    'não entendi',
    'estou ouvindo',
    'estou ouvindo.',
    'bem-vindo',
    'por favor repita',
    'certo',
    'ok',
    'entendi',
    'sim, certo',
    'sim, entendi'
];

// Função para filtrar frases do sistema (menos restritiva)
function filterSystemPhrases(text) {
    if (!text || text.trim().length === 0) {
        return null;
    }
    
    const lowerText = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    
    // Verificação especial para "estou ouvindo" - tentar extrair a parte útil
    if (lowerText.includes('estou ouvindo')) {
        const estouOuvindoIndex = text.toLowerCase().indexOf('estou ouvindo');
        const estouOuvindoLength = 'estou ouvindo'.length;
        
        // Sempre tentar extrair o que vem DEPOIS de "estou ouvindo" primeiro (geralmente é onde está a informação útil)
        const afterEstouOuvindo = text.substring(estouOuvindoIndex + estouOuvindoLength).trim();
        // Remover pontuação no início se houver
        const cleanedAfter = afterEstouOuvindo.replace(/^[.,!?;:\s]+/, '').trim();
        
        if (cleanedAfter.length >= 3) {
            // Verificar se o que vem depois não é apenas uma frase do sistema
            const cleanedLower = cleanedAfter.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const isSystemPhrase = SYSTEM_PHRASES.some(phrase => {
                const normalizedPhrase = phrase.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                return cleanedLower === normalizedPhrase || cleanedLower.startsWith(normalizedPhrase + ' ');
            });
            
            if (!isSystemPhrase) {
                console.log(`✅ Extraído após "estou ouvindo": "${cleanedAfter}"`);
                return cleanedAfter;
            }
        }
        
        // Se não há nada útil depois, tentar extrair o que vem ANTES (mas só se não for frase do sistema)
        if (estouOuvindoIndex > 0) {
            const beforeEstouOuvindo = text.substring(0, estouOuvindoIndex).trim();
            // Remover pontuação no final se houver
            const cleanedBefore = beforeEstouOuvindo.replace(/[.,!?;:\s]+$/, '').trim();
            
            if (cleanedBefore.length >= 3) {
                // Verificar se o que vem antes não é apenas uma frase do sistema
                const cleanedBeforeLower = cleanedBefore.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                const isSystemPhrase = SYSTEM_PHRASES.some(phrase => {
                    const normalizedPhrase = phrase.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                    return cleanedBeforeLower === normalizedPhrase || cleanedBeforeLower.endsWith(' ' + normalizedPhrase);
                });
                
                if (!isSystemPhrase) {
                    console.log(`✅ Extraído antes de "estou ouvindo": "${cleanedBefore}"`);
                    return cleanedBefore;
                }
            }
        }
        
        // Se não conseguiu extrair nada útil, filtrar completamente
        console.log(`⚠️ Filtrado: texto contém "estou ouvindo" sem conteúdo útil extraível: "${text}"`);
        return null;
    }
    
    // Verificar se o texto é APENAS uma frase do sistema (sem conteúdo adicional)
    // IMPORTANTE: Só filtrar se o texto for EXATAMENTE igual à frase do sistema
    for (const phrase of SYSTEM_PHRASES) {
        const normalizedPhrase = phrase.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
        
        // Se o texto é exatamente igual à frase do sistema (sem conteúdo adicional)
        if (lowerText === normalizedPhrase) {
            console.log(`⚠️ Filtrado: texto é exatamente frase do sistema: "${text}"`);
            return null;
        }
        
        // Se o texto começa e termina com a frase do sistema (sem conteúdo útil no meio)
        if (lowerText.startsWith(normalizedPhrase) && lowerText.length <= normalizedPhrase.length + 3) {
            console.log(`⚠️ Filtrado: texto é apenas frase do sistema: "${text}"`);
            return null;
        }
        
        // Se contém frase do sistema no meio ou no final, verificar se há conteúdo útil antes
        if (lowerText.includes(normalizedPhrase)) {
            // Se a frase do sistema está no final, remover e verificar se sobrou algo útil
            const beforePhrase = lowerText.substring(0, lowerText.indexOf(normalizedPhrase)).trim();
            if (beforePhrase.length < 3) {
                // Se não há conteúdo útil antes da frase do sistema, filtrar
                console.log(`⚠️ Filtrado: texto contém frase do sistema sem conteúdo útil antes: "${text}"`);
                return null;
            }
        }
        
        // Se começa com frase do sistema, tentar extrair a parte útil
        if (lowerText.startsWith(normalizedPhrase + ' ')) {
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
        console.log('⚠️ Texto filtrado ou vazio.');
        
        // Verificar se o texto original contém "estou ouvindo" - se sim, não tentar processar
        const originalLower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (originalLower.includes('estou ouvindo')) {
            console.log('⚠️ Texto contém "estou ouvindo" e não foi possível extrair conteúdo útil. Ignorando...');
            // Reiniciar gravação para tentar novamente
            if (currentConversationState !== 'welcome' && currentConversationState !== 'listening' && !isRecording) {
                setTimeout(async () => {
                    await startRecording();
                }, 2000);
            }
            return;
        }
        
        // Se o texto original tem conteúdo e não contém "estou ouvindo", usar ele mesmo (filtro pode ter sido muito restritivo)
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
        } else {
            // Texto vazio ou muito longo, pedir para repetir
            if (currentConversationState !== 'welcome' && currentConversationState !== 'listening' && !isRecording) {
                await playAudioFast('repeat');
                setTimeout(async () => {
                    await startRecording();
                }, 2000);
            }
        }
        return;
    }
    
    // Usar texto filtrado
    const lowerText = filteredText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // --- 1. INTENÇÕES PRINCIPAIS (Estados 'listening' ou 'welcome') ---
    // Ambos os estados são equivalentes para capturar comandos iniciais
    if (currentConversationState === 'listening' || currentConversationState === 'welcome') {
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
        // Validar que há texto válido antes de processar (mínimo 5 caracteres para evitar "De.", "dia", etc)
        if (!filteredText || filteredText.trim().length < 5) {
            console.log('⚠️ Texto de data muito curto ou vazio, pedindo para repetir...');
            // Limpar último texto processado para permitir nova tentativa
            lastProcessedText = null;
            lastProcessedState = null;
            await playAudioFast('repeat');
            // Não iniciar gravação automaticamente - aguardar usuário clicar no botão
            console.log('Aguardando usuário clicar no botão para tentar novamente...');
            return;
        }
        
        // Validar que o texto contém informações que parecem uma data (número + mês ou palavras-chave)
        const lowerText = filteredText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const hasNumber = /\d/.test(lowerText);
        const hasMonth = ['janeiro', 'fevereiro', 'março', 'marco', 'abril', 'maio', 'junho', 
                         'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'].some(month => lowerText.includes(month));
        const hasDateKeyword = ['hoje', 'amanha', 'amanhã', 'dia'].some(keyword => lowerText.includes(keyword));
        
        // Se tem número mas não tem mês nem palavra-chave de data, provavelmente não é uma data válida
        // (ex: "20 e CIN" tem número mas não é uma data)
        if (hasNumber && !hasMonth && !hasDateKeyword) {
            console.log('⚠️ Texto tem número mas não parece ser uma data válida (falta mês ou palavra-chave), pedindo para repetir...');
            lastProcessedText = null;
            lastProcessedState = null;
            await playAudioFast('repeat');
            console.log('Aguardando usuário clicar no botão para tentar novamente...');
            return;
        }
        
        // Se não tem número E não tem mês E não tem palavra-chave de data, provavelmente não é uma data
        if (!hasNumber && !hasMonth && !hasDateKeyword) {
            console.log('⚠️ Texto não parece ser uma data válida, pedindo para repetir...');
            lastProcessedText = null;
            lastProcessedState = null;
            await playAudioFast('repeat');
            console.log('Aguardando usuário clicar no botão para tentar novamente...');
            return;
        }
        
        // Validar que o texto não é o mesmo do nome do lembrete
        if (currentReminderData.name && 
            filteredText.trim().toLowerCase() === currentReminderData.name.trim().toLowerCase()) {
            console.log('⚠️ Texto de data é igual ao nome do lembrete, pedindo para repetir...');
            // Limpar último texto processado para permitir nova tentativa
            lastProcessedText = null;
            lastProcessedState = null;
            await playAudioFast('repeat');
            // Não iniciar gravação automaticamente - aguardar usuário clicar no botão
            console.log('Aguardando usuário clicar no botão para tentar novamente...');
            return;
        }
        
        await handleConversationFlow('reminder_date', { date: filteredText }); // Texto EXATO para normalização
        handled = true;
    }
    
    if (currentConversationState === 'reminder_time') {
        // Validar que há texto válido antes de processar
        if (!filteredText || filteredText.trim().length < 2) {
            console.log('⚠️ Texto de hora muito curto ou vazio, pedindo para repetir...');
            // Limpar último texto processado para permitir nova tentativa
            lastProcessedText = null;
            lastProcessedState = null;
            await playAudioFast('repeat');
            // Não iniciar gravação automaticamente - aguardar usuário clicar no botão
            console.log('Aguardando usuário clicar no botão para tentar novamente...');
            return;
        }
        
        // Validar que o texto não é igual à data capturada anteriormente (comparação mais robusta)
        if (currentReminderData.dateRaw) {
            const timeTextLower = filteredText.trim().toLowerCase();
            const dateRawLower = currentReminderData.dateRaw.trim().toLowerCase();
            // Comparar apenas se ambos tiverem comprimento similar (evitar falsos positivos)
            if (timeTextLower === dateRawLower && timeTextLower.length > 5) {
                console.log('⚠️ Texto de hora é igual à data capturada, pedindo para repetir...');
                // Limpar último texto processado para permitir nova tentativa
                lastProcessedText = null;
                lastProcessedState = null;
                await playAudioFast('repeat');
                // Não iniciar gravação automaticamente - aguardar usuário clicar no botão
                console.log('Aguardando usuário clicar no botão para tentar novamente...');
                return;
            }
        }
        
        // Validar que o texto não contém palavras relacionadas a data (dia, mês, etc)
        const lowerText = filteredText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const dateKeywords = ['dia', 'de', 'janeiro', 'fevereiro', 'março', 'marco', 'abril', 'maio', 'junho', 
                             'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro', 'hoje', 'amanha', 'amanhã'];
        const containsDateKeywords = dateKeywords.some(keyword => lowerText.includes(keyword));
        
        if (containsDateKeywords && lowerText.length > 5) {
            console.log('⚠️ Texto de hora contém palavras relacionadas a data, pedindo para repetir...');
            // Limpar último texto processado para permitir nova tentativa
            lastProcessedText = null;
            lastProcessedState = null;
            await playAudioFast('repeat');
            // Não iniciar gravação automaticamente - aguardar usuário clicar no botão
            console.log('Aguardando usuário clicar no botão para tentar novamente...');
            return;
        }
        
        await handleConversationFlow('reminder_time', { time: filteredText }); // Texto EXATO para normalização
        handled = true;
    }
    
    if (currentConversationState === 'reminder_repeat') {
        // Validar que há texto válido antes de processar
        if (!filteredText || filteredText.trim().length < 2) {
            console.log('⚠️ Texto de repetição muito curto ou vazio, pedindo para repetir...');
            // Limpar último texto processado para permitir nova tentativa
            lastProcessedText = null;
            lastProcessedState = null;
            await playAudioFast('repeat');
            // Não iniciar gravação automaticamente - aguardar usuário clicar no botão
            console.log('Aguardando usuário clicar no botão para tentar novamente...');
            return;
        }
        
        // Verificar se o texto contém dias da semana - se sim, interpretar como "sim" e avançar para reminder_days
        const weekdays = ['segunda', 'terça', 'terca', 'quarta', 'quinta', 'sexta', 'sábado', 'sabado', 'domingo'];
        const containsWeekdays = weekdays.some(day => lowerText.includes(day));
        
        if (containsWeekdays) {
            console.log('✅ Dias da semana detectados no estado reminder_repeat. Interpretando como "sim" e processando os dias diretamente.');
            // Definir repeat como true diretamente
            currentReminderData.repeat = true;
            console.log('✅ Repetir definido como true (implícito pelos dias mencionados).');
            // Processar os dias diretamente sem passar pelo fluxo normal de reminder_repeat
            // Limpar último texto processado ao mudar de estado
            lastProcessedText = null;
            lastProcessedState = null;
            // Processar os dias
            await handleConversationFlow('reminder_days', { repeatDays: [filteredText] });
            handled = true;
            return;
        }
        
        // Verificar se o texto contém palavras de negação primeiro
        const hasNo = lowerText.includes('não') || lowerText.includes('nao') || 
                     lowerText.includes('não quero') || lowerText.includes('nao quero') ||
                     lowerText.includes('não desejo') || lowerText.includes('nao desejo') ||
                     lowerText.includes('não gostaria') || lowerText.includes('nao gostaria');
        
        // Verificar se tem palavras de confirmação
        const hasYes = lowerText.includes('sim') || lowerText.includes('quero') || 
                      lowerText.includes('repetir') || lowerText.includes('desejo') ||
                      lowerText.includes('gostaria');
        
        // Se tiver negação, é false
        if (hasNo) {
            await handleConversationFlow('reminder_repeat', { repeat: false });
            handled = true;
        } else if (hasYes) {
            // Se tiver confirmação, é true
            await handleConversationFlow('reminder_repeat', { repeat: true });
            handled = true;
        } else {
            // Se não tiver nem confirmação nem negação clara, pedir para repetir
            console.log('⚠️ Resposta de repetição não clara, pedindo para repetir...');
            // Limpar último texto processado para permitir nova tentativa
            lastProcessedText = null;
            lastProcessedState = null;
            await playAudioFast('repeat');
            // Não iniciar gravação automaticamente - aguardar usuário clicar no botão
            console.log('Aguardando usuário clicar no botão para tentar novamente...');
            return;
        }
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
            // Limpar último texto processado ao mudar de estado
            lastProcessedText = null;
            lastProcessedState = null;
            // PRÓXIMO: DATA
            try { 
                await playAudioFast('reminderDate'); 
            } catch (error) { 
                await speakText('Que dia gostaria de ser lembrado?'); 
            }
            // Aguardar mais tempo para garantir que o áudio terminou completamente
            await new Promise(resolve => setTimeout(resolve, 2000));
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
                 // Limpar último texto processado para permitir nova tentativa
                 lastProcessedText = null;
                 lastProcessedState = null;
                 // Aguardar TTS terminar e reiniciar gravação (verificar se não está gravando)
                 await new Promise(resolve => setTimeout(resolve, 1500));
                 if (!isRecording && currentConversationState === 'reminder_date') {
                     await startRecording();
                 }
                 return;
            }
            
            console.log('✅ Data normalizada:', currentReminderData.date);
            // Limpar último texto processado ao mudar de estado
            lastProcessedText = null;
            lastProcessedState = null;
            // PRÓXIMO: HORA
            try { 
                await playAudioFast('reminderTime'); 
            } catch (error) { 
                await speakText('Que horas gostaria de ser lembrado?'); 
            }
            // Aguardar mais tempo para garantir que o áudio terminou completamente
            // Aumentado para 2 segundos para evitar capturar eco
            await new Promise(resolve => setTimeout(resolve, 2000));
            currentConversationState = 'reminder_time';
            await startRecording(); // Iniciar gravação após áudio terminar
            break;
            
        case 'reminder_time':
            // Armazenar APENAS o texto EXATO que o usuário falou (SEM normalização)
            currentReminderData.time = data.time.trim();
            console.log('✅ Hora capturada (exata, sem normalização):', currentReminderData.time);
            
            // Limpar último texto processado ao mudar de estado
            lastProcessedText = null;
            lastProcessedState = null;
            // PRÓXIMO: REPETIÇÃO
            try { 
                await playAudioFast('reminderRepeat'); 
            } catch (error) { 
                await speakText('Este é um lembrete que gostaria de repetir?'); 
            }
            // Aguardar mais tempo para garantir que o áudio terminou completamente
            // Aumentado para 2 segundos para evitar capturar eco
            await new Promise(resolve => setTimeout(resolve, 2000));
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
            // Armazenar APENAS o texto EXATO que o usuário falou (SEM normalização)
            const daysText = Array.isArray(data.repeatDays) ? data.repeatDays.join(' ') : data.repeatDays;
            currentReminderData.repeatDays = daysText.trim();
            console.log('✅ Dias capturados (exatos, sem normalização):', currentReminderData.repeatDays);
            
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
        // Agora repeatDays é uma string (texto exato), não um array
        return hasRequired && currentReminderData.repeatDays && currentReminderData.repeatDays.trim().length > 0;
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
    
    // Formatar mensagem de sucesso
    const dateFormatted = formatDateForSpeech(currentReminderData.date);
    let successMessage = `Lembrete criado com sucesso! Seu lembrete "${currentReminderData.name}" foi agendado para ${dateFormatted} às ${currentReminderData.time}.`;
    
    if (currentReminderData.repeat === true && currentReminderData.repeatDays) {
        successMessage += ` Este lembrete será repetido nos seguintes dias: ${currentReminderData.repeatDays}.`;
    } else if (currentReminderData.repeat === false) {
        successMessage += ` Este é um lembrete único, não será repetido.`;
    }
    
    await speakText(successMessage);
    
    // Mostrar feedback visual de sucesso
    showFeedback('✅ Lembrete criado com sucesso!', 'success');
    
    // Resetar estado
    currentConversationState = 'welcome';
    currentReminderData = {};
    lastProcessedText = null;
    lastProcessedState = null;
}

// Função para formatar data para fala (ex: "2025-12-31" -> "dia 31 de dezembro")
function formatDateForSpeech(dateString) {
    if (!dateString || !dateString.match(/\d{4}-\d{2}-\d{2}/)) {
        return dateString;
    }
    
    const [year, month, day] = dateString.split('-');
    const monthNames = [
        'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
        'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
    ];
    
    const monthIndex = parseInt(month, 10) - 1;
    const monthName = monthNames[monthIndex] || month;
    const dayNum = parseInt(day, 10);
    
    return `dia ${dayNum} de ${monthName}`;
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
    listeningAudioEndTime = null; // Limpar timestamp do áudio "listening"
    // Não limpar lastProcessedText aqui - ele deve persistir para evitar reprocessamento
    
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
                await new Promise(resolve => setTimeout(resolve, 200));
                await speakWelcomeMessage();
                isFirstTime = false;
            } catch (e) {
                console.log('Erro ao tocar boas-vindas após desbloqueio:', e);
                // Fallback para TTS
                await speakText(
                    'Bem-vindo ao sistema Memorae, sua agenda de lembretes. ' +
                    'Diga "criar lembrete", "editar lembrete", "excluir lembrete", ou "ver lembretes".'
                );
                setTimeout(async () => {
                    await speakOptions();
                }, 1000);
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
document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    // Verificar permissão apenas uma vez na inicialização
    await checkMicrophonePermission();
    initializeApp();
});