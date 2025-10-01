// Importa i moduli necessari
const functions = require("firebase-functions");
const admin = require("firebase-admin");

// Inizializza l'SDK di Firebase Admin per interagire con Firestore
admin.initializeApp();

/**
 * Cloud Function searchAgent - Agente di ricerca e analisi bandi
 * Si attiva alla creazione di un nuovo documento in 'grant_requests'
 * Configurazione: timeout 300s, memoria 1GB per gestire chiamate complesse
 */
exports.searchAgent = functions
    .runWith({
        timeoutSeconds: 300,
        memory: "1GB"
    })
    .firestore
    .document("grant_requests/{requestId}")
    .onCreate(async (snap, context) => {
        const requestData = snap.data().requestData;
        const docRef = snap.ref;

        functions.logger.info(`SearchAgent avviato per richiesta: ${context.params.requestId}`);

        try {
            // 1. Configurazione sicura - Lettura chiavi dall'ambiente Firebase
            const googleConfig = functions.config().google;
            const geminiApiKey = googleConfig.gemini_key;
            const searchApiKey = googleConfig.search_key;
            const searchEngineId = googleConfig.search_id;

            // 2. Costruzione dinamica delle query di ricerca
            const searchQueries = [
                `bandi finanziamenti ${requestData.settore} ${requestData.area} 2024 2025`,
                `contributi startup PMI ${requestData.dimensioni} ${requestData.settore} Italia`
            ];

            // 3. Esecuzione chiamate Google Custom Search API
            const rawSearchResults = [];
            
            for (const query of searchQueries) {
                const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${searchApiKey}&cx=${searchEngineId}&q=${encodeURIComponent(query)}&num=10`;
                
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

            // 4. Controllo risultati di ricerca - Terminazione con errore se vuoti
            if (rawSearchResults.length === 0) {
                throw new Error("Nessun risultato trovato dalle ricerche Google");
            }

            // 5. Aggregazione degli snippet di testo
            const aggregatedText = rawSearchResults
                .map(item => item.snippet)
                .filter(snippet => snippet && snippet.length > 0)
                .join(' ');

            functions.logger.info(`Raccolti ${rawSearchResults.length} risultati di ricerca`);

            // 6. Costruzione prompt dettagliato per Gemini
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

            // 7. Logging e tracciabilità - Salvataggio dati intermedi
            const logData = {
                googleSearchQueries: searchQueries,
                rawSearchResults: rawSearchResults,
                geminiInputPrompt: geminiPrompt,
                aggregatedTextLength: aggregatedText.length,
                timestamp: new Date()
            };

            await docRef.collection('analysis_log').doc('search_data').set(logData);
            functions.logger.info('Dati intermedi salvati in analysis_log');

            // 8. Chiamata API Gemini per analisi
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${geminiApiKey}`;
            
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
            
            // 9. Estrazione e pulizia del testo grezzo
            let analysisText = geminiData.candidates[0].content.parts[0].text;
            
            // Pulizia da markdown di codice JSON
            analysisText = analysisText
                .replace(/```json/g, '')
                .replace(/```/g, '')
                .trim();

            functions.logger.info('Testo grezzo da Gemini pulito', { textLength: analysisText.length });

            // 10. Parsing JSON sicuro in blocco try-catch dedicato
            let analysisResult;
            try {
                analysisResult = JSON.parse(analysisText);
            } catch (parseError) {
                functions.logger.error('Errore nel parsing JSON:', { 
                    parseError: parseError.message,
                    rawText: analysisText.substring(0, 500) // Log primi 500 caratteri per debug
                });
                throw new Error(`Errore nel parsing JSON della risposta Gemini: ${parseError.message}`);
            }

            functions.logger.info("Analisi da Gemini completata con successo", {
                bandiTrovati: analysisResult.foundBandi?.length || 0
            });

            // 11. Aggiornamento stato di successo
            return docRef.update({
                status: 'analysis_complete',
                analysisResult: analysisResult,
                completedAt: new Date()
            });

        } catch (error) {
            // 12. Gestione errori robusta
            functions.logger.error("Errore durante l'analisi con SearchAgent:", {
                error: error.message,
                stack: error.stack,
                requestId: context.params.requestId
            });

            // Aggiornamento stato di fallimento con dettagli errore
            return docRef.update({
                status: 'analysis_failed',
                errorDetails: {
                    message: error.message,
                    timestamp: new Date(),
                    requestId: context.params.requestId
                }
            });
        }
    });