// functions/index.js - Versione di Produzione Corretta
const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

// Recupera le chiavi API in modo sicuro dalla configurazione dell'ambiente
const GEMINI_API_KEY = functions.config().google.gemini_key;
const SEARCH_API_KEY = functions.config().google.search_key;
const SEARCH_ENGINE_ID = functions.config().google.search_id;

/**
 * Agente #1: Si attiva alla creazione di una richiesta, esegue ricerche web,
 * analizza i risultati con un LLM e salva un report strutturato.
 */
exports.searchAgent = functions.runWith({timeoutSeconds: 300, memory: "1GB"}).firestore
    .document("grant_requests/{requestId}")
    .onCreate(async (snap, context) => {
      const {requestId} = context.params;
      const requestData = snap.data().requestData;
      const docRef = snap.ref;

      functions.logger.info(`[${requestId}] - Avvio Agente di Ricerca per:`, requestData);

      try {
        const queries = [
          `bando attivo ${requestData.settore} ${requestData.dimensioni} ${requestData.area}`,
          `finanziamento a fondo perduto ${requestData.settore} ${requestData.area} 2025`,
        ];

        const searchSnippets = [];
        for (const q of queries) {
          const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${SEARCH_API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(q)}`;
          const searchResponse = await fetch(searchUrl);
          if (!searchResponse.ok) {
            throw new Error(`Google Search API ha risposto con errore ${searchResponse.status}: ${searchResponse.statusText}`);
          }
          const searchData = await searchResponse.json();
          if (searchData.items) {
            searchData.items.forEach((item) => {
              searchSnippets.push(item.snippet);
            });
          }
        }

        if (searchSnippets.length === 0) {
          functions.logger.warn(`[${requestId}] - La ricerca non ha prodotto risultati.`);
          return docRef.update({status: "analysis_failed", errorDetails: "La ricerca web non ha prodotto risultati pertinenti."});
        }
        functions.logger.info(`[${requestId}] - Trovati ${searchSnippets.length} snippet.`);

        const geminiInputPrompt = `Sei un consulente esperto in finanza agevolata. Analizza i seguenti snippet per un'azienda con queste caratteristiche: Settore: ${requestData.settore}, Dimensione: ${requestData.dimensioni}, Area: ${requestData.area}. Estrai i 3 bandi più pertinenti. Rispondi esclusivamente in formato JSON valido, senza markdown, con questa struttura: {"summary": "...", "foundBandi": [{"nomeBando": "...", "ente": "...", "descrizione": "...", "scadenza": "..."}]}.\n\nSNIPPETS:\n${searchSnippets.join("\n---\n")}`;

        await docRef.collection("analysis_log").doc("search_data").set({
          googleSearchQueries: queries,
          rawSearchResults: searchSnippets,
          geminiInputPrompt: geminiInputPrompt,
        });

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;
        const geminiResponse = await fetch(geminiUrl, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({contents: [{parts: [{text: geminiInputPrompt}]}]}),
        });

        if (!geminiResponse.ok) {
          const errorBody = await geminiResponse.text();
          throw new Error(`Gemini API ha risposto con errore ${geminiResponse.status}: ${errorBody}`);
        }
        const geminiData = await geminiResponse.json();

        // Blocco di parsing sicuro
        let analysisResult;
        try {
          const rawJson = geminiData.candidates[0].content.parts[0].text;
          const cleanedJson = rawJson.replace(/```json|```/g, "").trim();
          analysisResult = JSON.parse(cleanedJson);
        } catch (parseError) {
          throw new Error(`Errore nel parsing del JSON da Gemini: ${parseError.message}`);
        }

        functions.logger.info(`[${requestId}] - Analisi da Gemini ricevuta e parsata con successo.`);

        return docRef.update({
          status: "analysis_complete",
          analysisResult: analysisResult,
        });
      } catch (error) {
        functions.logger.error(`[${requestId}] - Errore critico nell'agente di ricerca:`, error);
        return docRef.update({status: "analysis_failed", errorDetails: error.message});
      }
    });
