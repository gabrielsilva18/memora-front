# Memora - Agenda Falante

Uma interface web completamente guiada por voz para o projeto "Agenda Falante", desenvolvida especificamente para idosos com foco em acessibilidade e usabilidade.

## 🎯 Características

- **Interface Completamente por Voz**: Navegação 100% guiada por áudio
- **Design Minimalista**: Apenas 2 botões principais - gravação e controle de som
- **Síntese de Voz**: Sistema completo de feedback sonoro usando Web Speech API
- **Captura de Áudio**: Sistema completo de gravação e envio de áudio para backend
- **Acessibilidade Total**: Foco em usuários idosos que não sabem ler ou escrever

## 🚀 Funcionalidades Implementadas

### Interface Principal
- **Logo Personalizado**: Espaço reservado para logo personalizada
- **Botão de Gravação Principal**: Interface clara para captura de áudio
- **Botão de Controle de Som**: Ativar/desativar feedback sonoro
- **Design Minimalista**: Sem textos visuais, apenas ícones grandes

### Navegação por Voz
- **Mensagem de Boas-vindas**: Sistema fala automaticamente ao entrar
- **Orientação por Voz**: Explica opções disponíveis (criar, editar, excluir, ver lembretes)
- **Feedback Sonoro**: Todas as ações têm feedback em áudio
- **Síntese de Voz**: Usa Web Speech API para falar em português brasileiro

### Captura de Áudio
- **Gravação em Tempo Real**: Captura de áudio com feedback visual
- **Controle de Qualidade**: Configurações otimizadas para reconhecimento de voz
- **Envio Automático**: Integração com backend para processamento
- **Tratamento de Erros**: Feedback sonoro em caso de problemas

### Comunicação com Backend
- **Endpoint de Áudio**: `POST /api/audio` para envio de gravações
- **Configuração Flexível**: URL do backend configurável
- **Tratamento de Respostas**: Processamento de respostas do servidor
- **Feedback Automático**: Confirmações sonoras de sucesso/erro

## 📁 Estrutura de Arquivos

```
├── index.html          # Estrutura HTML principal
├── styles.css          # Estilos CSS responsivos
├── script.js           # Lógica JavaScript e captura de áudio
└── README.md           # Documentação do projeto
```

## 🛠️ Configuração

### Backend Necessário
O frontend espera um backend com os seguintes endpoints:

```javascript
// Configuração no script.js
const CONFIG = {
    backendUrl: 'http://localhost:3000/api', // Ajuste conforme necessário
    maxRecordingTime: 60000, // 60 segundos
    audioFormat: 'audio/webm;codecs=opus'
};
```

### Endpoints Esperados

1. **POST /api/audio**
   - Recebe: FormData com arquivo de áudio
   - Retorna: `{ success: boolean, audioResponse?: string }`

2. **POST /api/mood**
   - Recebe: `{ mood: string, timestamp: string }`
   - Retorna: Confirmação de recebimento

3. **GET /api/reminders**
   - Retorna: Array de lembretes cadastrados

## 🎨 Design

### Paleta de Cores
- **Primária**: Gradiente azul/roxo (#667eea → #764ba2)
- **Secundária**: Verde para ações principais (#48bb78)
- **Neutra**: Tons de cinza para textos e fundos
- **Feedback**: Verde (sucesso), vermelho (erro), amarelo (processamento)

### Tipografia
- **Fonte**: Inter (Google Fonts)
- **Tamanhos**: Responsivos para diferentes telas
- **Peso**: Variado para hierarquia visual

### Responsividade
- **Desktop**: Layout otimizado para telas grandes
- **Tablet**: Adaptação para dispositivos médios
- **Mobile**: Interface simplificada para celulares

## 🔧 Funcionalidades Técnicas

### Captura de Áudio
```javascript
// Configuração otimizada para reconhecimento de voz
const stream = await navigator.mediaDevices.getUserMedia({ 
    audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 44100
    } 
});
```

### Envio para Backend
```javascript
// FormData com metadados
const formData = new FormData();
formData.append('audio', audioBlob, 'recording.webm');
formData.append('timestamp', new Date().toISOString());
```

### Estados da Interface
- **Pronto**: Interface aguardando interação
- **Gravando**: Feedback visual e sonoro durante gravação
- **Processando**: Indicador de processamento do áudio
- **Erro**: Feedback claro em caso de problemas

## 🚀 Como Usar

1. **Abrir o arquivo**: Abra `index.html` em um navegador moderno
2. **Permitir microfone**: Autorize o acesso ao microfone quando solicitado
3. **Escutar orientações**: O sistema falará automaticamente as opções disponíveis
4. **Gravar lembrete**: Clique no botão do microfone e fale
5. **Aguardar processamento**: O sistema enviará o áudio para o backend
6. **Receber feedback**: Confirmação sonora do sucesso e orientações para próximos passos

## ⚠️ Solução de Problemas

### Problema: Permissão do Microfone Continua Sendo Solicitada

Se o sistema continua pedindo permissão do microfone mesmo após você permitir, isso geralmente acontece por:

#### 1. **Problema de HTTPS/HTTP**
Alguns navegadores modernos (especialmente Chrome e Edge) exigem HTTPS para acesso ao microfone, exceto quando rodando em `localhost` ou `127.0.0.1`.

**Soluções:**
- **Usar Live Server em localhost**: O Live Server geralmente já roda em `localhost`, o que deve funcionar
- **Configurar HTTPS local**: Use ferramentas como `mkcert` ou `ngrok` para criar um servidor HTTPS local
- **Usar extensão do navegador**: Algumas extensões permitem forçar HTTPS local

#### 2. **Permissões do Navegador Bloqueadas**
Se você negou a permissão anteriormente, o navegador pode estar bloqueando.

**Como resolver:**
- **Chrome/Edge**: 
  1. Clique no ícone de cadeado/câmera na barra de endereço
  2. Vá em "Configurações do site"
  3. Altere "Microfone" para "Permitir"
  4. Recarregue a página

- **Firefox**:
  1. Clique no ícone de cadeado na barra de endereço
  2. Clique em "Mais informações"
  3. Na aba "Permissões", altere "Usar o microfone" para "Permitir"
  4. Recarregue a página

- **Safari**:
  1. Vá em Safari > Preferências > Websites
  2. Selecione "Microfone" no menu lateral
  3. Altere a permissão para o site

#### 3. **Múltiplas Chamadas de Permissão**
O código foi atualizado para evitar múltiplas solicitações. Se ainda ocorrer:
- Recarregue a página completamente (Ctrl+F5 ou Cmd+Shift+R)
- Limpe o cache do navegador
- Feche e reabra o navegador

#### 4. **Microfone Não Detectado**
- Verifique se há um microfone conectado
- Teste o microfone em outro aplicativo
- Verifique as configurações do sistema operacional

### Verificação de Protocolo
O sistema agora verifica automaticamente se está rodando em HTTPS ou localhost. Se você ver um aviso no console sobre HTTP, considere usar HTTPS ou garantir que está acessando via `localhost`.

## 🔒 Segurança e Privacidade

- **Permissões**: Solicita apenas acesso ao microfone
- **Dados Locais**: Não armazena áudio localmente
- **Transmissão**: Envia áudio diretamente para o backend configurado
- **Feedback**: Confirmações claras sobre o status das operações

## 📱 Compatibilidade

- **Navegadores**: Chrome, Firefox, Safari, Edge (versões modernas)
- **Dispositivos**: Desktop, tablet, mobile
- **Sistemas**: Windows, macOS, Linux, Android, iOS
- **Recursos**: Requer suporte a MediaRecorder API

## 🎯 Próximos Passos

1. **Integração com Backend**: Conectar com servidor de processamento
2. **Testes de Usabilidade**: Validar com usuários idosos
3. **Melhorias de Acessibilidade**: Ajustes baseados em feedback
4. **Funcionalidades Adicionais**: Expandir recursos conforme necessário

---

**Desenvolvido com foco em acessibilidade e usabilidade para idosos.**
