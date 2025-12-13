# backend/app/services/openai_service.py
"""
OpenAI service for receipt data extraction using structured outputs.
"""
from typing import Optional, Dict, Any, List
from openai import OpenAI
from pydantic import BaseModel, Field
from app.core.config import settings
from app.core.logging import get_logger
from app.models.receipt import ReceiptData

logger = get_logger(__name__)


# ============================================================================
# Extraction Models (for OpenAI structured output)
# ============================================================================

class StoreInfo(BaseModel):
    name: str
    address: Optional[str] = None
    phone: Optional[str] = None


class BillItem(BaseModel):
    name: str
    quantity: int = 1
    unit_price: float
    total_price: float


class TaxOrCharge(BaseModel):
    name: str
    amount: float


class ReceiptExtraction(BaseModel):
    """Schema for OpenAI structured extraction."""
    receipt_number: str = Field(description="Receipt/order number, generate 'RCP-001' if missing")
    date: str = Field(description="Date in YYYY-MM-DD format")
    time: str = Field(description="Time in HH:MM format")
    store: StoreInfo
    items: List[BillItem]
    subtotal: float = Field(description="Subtotal before taxes, use 0.00 if not shown")
    taxes_or_charges: List[TaxOrCharge] = Field(
        description="All taxes, charges, discounts (negative for discounts)"
    )
    grand_total: float = Field(description="Final total amount - MANDATORY")
    payment_method: str = "Unknown"
    transaction_id: Optional[str] = None
    notes: Optional[str] = None


# ============================================================================
# OpenAI Service
# ============================================================================

class OpenAIService:
    def __init__(self):
        if not settings.openai_api_key:
            logger.warning("OpenAI API key not configured - extraction will not work")
            self.client = None
            return
        self.client = OpenAI(api_key=settings.openai_api_key)

    def extract_receipt_data(self, raw_text: str) -> Optional[ReceiptData]:
        """
        Extract structured receipt data from raw OCR text.
        
        Args:
            raw_text: Raw text from OCR
            
        Returns:
            Validated ReceiptData object
            
        Raises:
            ValueError: If validation fails (with unvalidated_data attached)
        """
        if not self.client:
            logger.error("OpenAI service not initialized")
            return None
            
        operation_id = f"extract_{hash(raw_text) % 10000}"
        
        try:
            self._log_input_stats(raw_text, operation_id)
            logger.info(f"[{operation_id}] Starting extraction")
            
            # Extract using OpenAI
            extraction = self._extract_with_structured_output(raw_text, operation_id)
            if not extraction:
                return None
            
            data_dict = extraction.model_dump()
            
            # Create unvalidated receipt BEFORE validation (for error recovery)
            from app.models.receipt import StoreInfo as ModelStoreInfo, BillItem as ModelBillItem, TaxOrCharge as ModelTaxOrCharge
            
            unvalidated_receipt = ReceiptData(
                receipt_number=data_dict.get("receipt_number", "RCP-001"),
                date=data_dict.get("date", ""),
                time=data_dict.get("time", ""),
                store=ModelStoreInfo(**data_dict.get("store", {"name": "Unknown"})),
                items=[ModelBillItem(**item) for item in data_dict.get("items", [])],
                subtotal=data_dict.get("subtotal", 0.0),
                taxes_or_charges=[ModelTaxOrCharge(**tc) for tc in data_dict.get("taxes_or_charges", [])],
                grand_total=data_dict.get("grand_total", 0.0),
                payment_method=data_dict.get("payment_method", "Unknown"),
                transaction_id=data_dict.get("transaction_id"),
                notes=data_dict.get("notes")
            )
            
            logger.info(f"[{operation_id}] Created unvalidated receipt")
            
            # Validate
            try:
                validated_dict = self._post_process_and_validate(data_dict, operation_id)
                
                receipt_data = ReceiptData(
                    receipt_number=validated_dict["receipt_number"],
                    date=validated_dict["date"],
                    time=validated_dict["time"],
                    store=ModelStoreInfo(**validated_dict["store"]),
                    items=[ModelBillItem(**item) for item in validated_dict["items"]],
                    subtotal=validated_dict["subtotal"],
                    taxes_or_charges=[
                        ModelTaxOrCharge(**tc) for tc in validated_dict.get("taxes_or_charges", [])
                    ],
                    grand_total=validated_dict["grand_total"],
                    payment_method=validated_dict.get("payment_method", "Unknown"),
                    transaction_id=validated_dict.get("transaction_id"),
                    notes=validated_dict.get("notes")
                )
                
                logger.info(f"[{operation_id}] Validation successful")
                return receipt_data
                
            except ValueError as ve:
                # Attach unvalidated data for user correction
                logger.error(f"[{operation_id}] Validation failed, attaching unvalidated data")
                ve.unvalidated_data = unvalidated_receipt
                raise ve
            
        except ValueError:
            raise
        except Exception as e:
            self._log_extraction_error(e, operation_id)
            return None

    def _extract_with_structured_output(
        self, raw_text: str, operation_id: str
    ) -> Optional[ReceiptExtraction]:
        """Core LLM extraction using OpenAI structured output."""
        try:
            system_prompt = """You are a receipt data extraction expert. Extract information with these rules:

CRITICAL RULES:
1. grand_total is MANDATORY - the final amount payable
2. Extract ALL taxes, charges, discounts into taxes_or_charges (negative for discounts)
3. subtotal: Use receipt value if shown, else 0.00 (DO NOT calculate)
4. DO NOT perform calculations - extract amounts exactly as shown
5. Extract ALL items, don't miss any

Return JSON format only, no markdown or explanations."""

            user_prompt = f"""Extract receipt data from this text:

{raw_text}

Return structured JSON according to the schema."""
            
            logger.info(f"[{operation_id}] Calling OpenAI")

            completion = self.client.chat.completions.parse(
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                response_format=ReceiptExtraction,
            )

            self._log_api_response(completion, operation_id)
            
            if not completion.choices[0].message.parsed:
                logger.error(f"[{operation_id}] No parsed data returned")
                return None
            
            extraction = completion.choices[0].message.parsed
            
            logger.info(f"[{operation_id}] Extracted {len(extraction.items)} items, total: {extraction.grand_total}")
            
            return extraction
            
        except Exception as e:
            logger.error(f"[{operation_id}] OpenAI extraction failed: {str(e)}")
            return None

    def _post_process_and_validate(self, data: Dict[str, Any], operation_id: str) -> Dict[str, Any]:
        """Delegate validation to receipt validator service."""
        from app.services.receipt_validator import receipt_validator_service
        
        logger.info(f"[{operation_id}] Delegating to validator")
        return receipt_validator_service.validate_and_process_receipt(data, operation_id)

    def _log_input_stats(self, raw_text: str, operation_id: str) -> None:
        """Log input statistics."""
        stats = {
            "chars": len(raw_text),
            "words": len(raw_text.split()),
            "lines": len(raw_text.splitlines()),
        }
        logger.info(f"[{operation_id}] Input: {stats}")

    def _log_api_response(self, completion, operation_id: str) -> None:
        """Log API response details."""
        stats = {
            "tokens": completion.usage.total_tokens if completion.usage else 0,
            "model": completion.model,
            "finish_reason": completion.choices[0].finish_reason,
        }
        logger.info(f"[{operation_id}] Response: {stats}")

    def _log_extraction_error(self, error: Exception, operation_id: str) -> None:
        """Log extraction errors."""
        logger.error(f"[{operation_id}] Extraction failed: {type(error).__name__}: {str(error)}")


# Global OpenAI service instance
openai_service = OpenAIService()
