// Importa i moduli necessari per Cloud Functions v2
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions");

// Imposta la regione globale delle funzioni
setGlobalOptions({ region: "europe-west1" });

// Inizializza l'SDK di Firebase Admin per interagire con Firestore
admin.initializeApp();

/**
 * Cloud Function searchAgent - Agente di ricerca e analisi bandi
 * Si attiva alla creazione di un nuovo documento in 'grant_requests'
 * Configurazione: timeout 300s, memoria 1GB per gestire chiamate complesse
 */
exports.searchAgent = onDocumentCreated(
    {
        document: "grant_requests/{requestId}",
        timeoutSeconds: 300,
        memory: "1GB"
    },
    async (event) => {
        const requestData = event.data.data().requestData;
        const docRef = event.data.ref;

        logger.info(`SearchAgent avviato per richiesta: ${event.params.requestId}`);

        try {
            // 1. Lettura sicura della configurazione - Definizione costanti all'interno del gestore
            const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
            const SEARCH_API_KEY = process.env.SEARCH_API_KEY;
            const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;

            // 2. Controllo dell'ambiente - Verifica se le chiavi sono definite
            if (!GEMINI_API_KEY || !SEARCH_API_KEY || !SEARCH_ENGINE_ID) {
                const missingKeys = [];
                if (!GEMINI_API_KEY) missingKeys.push('GEMINI_API_KEY');
                if (!SEARCH_API_KEY) missingKeys.push('SEARCH_API_KEY');
                if (!SEARCH_ENGINE_ID) missingKeys.push('SEARCH_ENGINE_ID');

                logger.error(`Configurazione mancante. Chiavi non definite: ${missingKeys.join(', ')}. Questo è normale nell'emulatore locale.`);
                
                return docRef.update({
                    status: 'config_error',
                    errorDetails: {
                        message: `Configurazione mancante: ${missingKeys.join(', ')}`,
                        timestamp: new Date(),
                        environment: 'emulator'
                    }
                });
            }

            // 3. Costruzione dinamica delle query di ricerca
            const searchQueries = [
                `bandi finanziamenti ${requestData.settore} ${requestData.area} 2024 2025`,
                `contributi startup PMI ${requestData.dimensioni} ${requestData.settore} Italia`
            ];

            // 4. Esecuzione chiamate Google Custom Search API
            const rawSearchResults = [];
            
            for (const query of searchQueries) {
                const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${SEARCH_API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=10`;
                
                const searchResponse = await fetch(searchUrl);
                const searchData = await searchResponse.json();
                
                if (searchData.items) {
                    searchData.items.forEach(item => {
                        rawSearchResults.push({
                            title: item.title,
                            link: item.link,
                            snippet: item.snippet
                        });
                    });
                }
            }

            // 5. Controllo risultati di ricerca - Terminazione con errore se vuoti
            if (rawSearchResults.length === 0) {
                throw new Error("Nessun risultato trovato dalle ricerche Google");
            }

            // 6. Aggregazione degli snippet di testo
            const aggregatedText = rawSearchResults
                .map(item => item.snippet)
                .filter(snippet => snippet && snippet.length > 0)
                .join(' ');

            logger.info(`Raccolti ${rawSearchResults.length} risultati di ricerca`);

            // 7. Costruzione prompt dettagliato per Gemini
            const geminiPrompt = `
Sei un consulente senior esperto in finanza agevolata per il mercato italiano.

Analizza il seguente testo che contiene informazioni sui bandi e finanziamenti italiani.
Identifica i 3 bandi più rilevanti e attuali per un'azienda con queste caratteristiche:
- Settore: ${requestData.settore}
- Dimensione: ${requestData.dimensioni}
- Numero Dipendenti: ${requestData.dipendenti}
- Area Geografica: ${requestData.area}

Testo da analizzare:
${aggregatedText}

IMPORTANTE: Rispondi ESCLUSIVAMENTE in formato JSON valido, senza markdown, senza backticks, senza testo introduttivo o conclusivo.

Struttura JSON richiesta:
{
  "summary": "Breve riassunto delle opportunità identificate",
  "foundBandi": [
    {
      "nomeBando": "Nome completo del bando",
      "ente": "Ente erogatore",
      "descrizione": "Descrizione dettagliata del bando",
      "scadenza": "Data di scadenza se disponibile"
    }
  ]
}`;

            // 8. Logging e tracciabilità - Salvataggio dati intermedi
            const logData = {
                googleSearchQueries: searchQueries,
                rawSearchResults: rawSearchResults,
                geminiInputPrompt: geminiPrompt,
                aggregatedTextLength: aggregatedText.length,
                timestamp: new Date()
            };

            await docRef.collection('analysis_log').doc('search_data').set(logData);
            logger.info('Dati intermedi salvati in analysis_log');

            // 9. Chiamata API Gemini per analisi
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;
            
            const geminiResponse = await fetch(geminiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: geminiPrompt }]
                    }]
                })
            });

            if (!geminiResponse.ok) {
                throw new Error(`Gemini API error: ${geminiResponse.status} ${geminiResponse.statusText}`);
            }

            const geminiData = await geminiResponse.json();
            
            // 10. Estrazione e pulizia del testo grezzo
            let analysisText = geminiData.candidates[0].content.parts[0].text;
            
            // Pulizia da markdown di codice JSON
            analysisText = analysisText
                .replace(/```json/g, '')
                .replace(/```/g, '')
                .trim();

            logger.info('Testo grezzo da Gemini pulito', { textLength: analysisText.length });

            // 11. Parsing JSON sicuro in blocco try-catch dedicato
            let analysisResult;
            try {
                analysisResult = JSON.parse(analysisText);
            } catch (parseError) {
                logger.error('Errore nel parsing JSON:', { 
                    parseError: parseError.message,
                    rawText: analysisText.substring(0, 500) // Log primi 500 caratteri per debug
                });
                throw new Error(`Errore nel parsing JSON della risposta Gemini: ${parseError.message}`);
            }

            logger.info("Analisi da Gemini completata con successo", {
                bandiTrovati: analysisResult.foundBandi?.length || 0
            });

            // 12. Aggiornamento stato di successo
            return docRef.update({
                status: 'analysis_complete',
                analysisResult: analysisResult,
                completedAt: new Date()
            });

        } catch (error) {
            // 13. Gestione errori robusta
            logger.error("Errore durante l'analisi con SearchAgent:", {
                error: error.message,
                stack: error.stack,
                requestId: event.params.requestId
            });

            // Aggiornamento stato di fallimento con dettagli errore
            return docRef.update({
                status: 'analysis_failed',
                errorDetails: {
                    message: error.message,
                    timestamp: new Date(),
                    requestId: event.params.requestId
                }
            });
        }
    }
);