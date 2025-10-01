// Importa i moduli necessari
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

// Inizializza l'SDK di Firebase Admin per interagire con Firestore
admin.initializeApp();

// Configura il client per Amazon Bedrock
// Le credenziali verranno gestite in modo sicuro, non direttamente qui.
const bedrockClient = new BedrockRuntimeClient({
    region: "us-east-1", // Assicurati sia la regione corretta per te
    credentials: {
        accessKeyId: functions.config().aws.key,
        secretAccessKey: functions.config().aws.secret,
    },
});

/**
 * Cloud Function che si attiva alla creazione di un nuovo documento in 'grant_requests'.
 * Questo è il nostro agente AI.
 */
exports.analyzeGrantRequest = functions.firestore
    .document("grant_requests/{requestId}")
    .onCreate(async (snap, context) => {
        // Prende i dati della richiesta appena creata
        const requestData = snap.data().requestData;
        const docRef = snap.ref; // Riferimento al documento per poterlo aggiornare

        functions.logger.info(`Nuova richiesta ricevuta: ${context.params.requestId}`, { structuredData: true });

        // 1. Costruisci il prompt per l'LLM
        const prompt = `
            Sei un consulente senior esperto in finanza agevolata per il mercato italiano.
            Analizza i seguenti dati di un'azienda cliente:
            - Settore: ${requestData.settore}
            - Dimensione: ${requestData.dimensioni}
            - Numero Dipendenti: ${requestData.dipendenti}
            - Area Geografica: ${requestData.area}

            Basandoti su questi dati, identifica i 3 bandi (regionali, nazionali o europei) più pertinenti e attivi in questo momento. Per ogni bando, fornisci una breve descrizione, l'ente erogatore e la data di scadenza.
            
            Fornisci la risposta esclusivamente in formato JSON valido, senza testo introduttivo o conclusivo, seguendo questa struttura esatta:
            {
              "summary": "Un riassunto di una singola frase delle opportunità identificate.",
              "foundBandi": [
                {
                  "nomeBando": "Nome del Bando 1",
                  "ente": "Ente Erogatore 1",
                  "descrizione": "Breve descrizione del bando 1.",
                  "scadenza": "GG/MM/AAAA"
                }
              ]
            }
        `;

        // 2. Prepara e invia la richiesta a Amazon Bedrock
        const params = {
            modelId: "anthropic.claude-v2", // Modello potente per analisi di testo
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
                prompt: `\n\nHuman: ${prompt}\n\nAssistant:`,
                max_tokens_to_sample: 2048,
                temperature: 0.5,
            }),
        };

        try {
            const command = new InvokeModelCommand(params);
            const response = await bedrockClient.send(command);
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            
            // Estrae e pulisce la risposta JSON dall'LLM
            const analysisResult = JSON.parse(responseBody.completion.trim());
            functions.logger.info("Analisi da Bedrock ricevuta:", analysisResult);

            // 3. Aggiorna il documento in Firestore con i risultati
            return docRef.update({
                status: "analysis_complete",
                analysisResult: analysisResult,
            });

        } catch (error) {
            functions.logger.error("Errore durante l'analisi con Bedrock o l'aggiornamento del documento:", error);
            // In caso di errore, aggiorna il documento per segnalare il fallimento
            return docRef.update({
                status: "analysis_failed",
                errorDetails: error.message,
            });
        }
    });