# backend/app/api/routes/receipt.py
"""
Stateless receipt processing endpoint.
Processes image → OCR → extraction → validation in a single call.
"""
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from typing import Optional
import os

from app.services.ocr_service import ocr_service
from app.services.openai_service import openai_service
from app.utils.file_handler import file_handler
from app.schemas.receipt_schema import (
    ReceiptProcessResponse,
    ReceiptDataSchema,
    StoreInfoSchema,
    BillItemSchema,
    TaxOrChargeSchema
)
from app.api.dependencies import get_logger_dependency

router = APIRouter(prefix="/receipt", tags=["receipt"])


@router.post("/process", response_model=ReceiptProcessResponse)
async def process_receipt(
    file: UploadFile = File(...),
    logger=Depends(get_logger_dependency)
):
    """
    Process a receipt image in a single stateless call.
    
    Flow: Upload → OCR → AI Extraction → Validation → Response
    
    Returns validated receipt data, or validation errors with extracted data
    for user correction.
    """
    file_path: Optional[str] = None
    
    try:
        # 1. Validate file
        logger.info(f"Processing receipt: {file.filename}")
        is_valid, error_message = file_handler.validate_file(file)
        if not is_valid:
            logger.warning(f"File validation failed: {error_message}")
            raise HTTPException(status_code=400, detail=error_message)
        
        # 2. Save file temporarily
        file_path = file_handler.save_file(file)
        if not file_path:
            logger.error("Failed to save uploaded file")
            raise HTTPException(status_code=500, detail="Failed to save file")
        
        logger.info(f"File saved to: {file_path}")
        
        # 3. OCR extraction
        logger.info("Starting OCR extraction")
        raw_text = ocr_service.extract_text_from_image(file_path)
        
        if not raw_text:
            logger.error("OCR extraction returned no text")
            raise HTTPException(
                status_code=422, 
                detail="Could not extract text from image. Please ensure the image is clear and contains readable text."
            )
        
        logger.info(f"OCR extracted {len(raw_text)} characters")
        
        # 4. AI extraction + validation
        try:
            logger.info("Starting AI data extraction")
            processed_data = openai_service.extract_receipt_data(raw_text)
            
            if not processed_data:
                logger.error("AI extraction returned no data")
                raise HTTPException(
                    status_code=422,
                    detail="Could not extract structured data from receipt text."
                )
            
            # Convert to schema for response
            response_data = _convert_to_schema(processed_data)
            
            logger.info("Receipt processed successfully")
            return ReceiptProcessResponse(
                success=True,
                message="Receipt processed successfully",
                processed_data=response_data,
                raw_text=raw_text
            )
            
        except ValueError as e:
            # Validation failed but extraction succeeded
            # Return extracted data with error details for user correction
            error_msg = str(e)
            logger.warning(f"Validation failed: {error_msg}")
            
            extracted_data = None
            if hasattr(e, 'unvalidated_data') and e.unvalidated_data:
                extracted_data = _convert_to_schema(e.unvalidated_data)
            
            raise HTTPException(
                status_code=422,
                detail={
                    "error": "Receipt Validation Failed",
                    "message": _format_user_friendly_error(error_msg),
                    "technical_details": error_msg,
                    "extracted_data": extracted_data.model_dump() if extracted_data else None,
                    "raw_text": raw_text,
                    "suggestions": [
                        "Review the extracted amounts for accuracy",
                        "Check for OCR errors in item prices",
                        "Verify tax calculations match the receipt"
                    ]
                }
            )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error processing receipt: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")
    
    finally:
        # Clean up temporary file
        if file_path and os.path.exists(file_path):
            try:
                file_handler.delete_file(file_path)
                logger.info("Cleaned up temporary file")
            except Exception as cleanup_error:
                logger.warning(f"Failed to clean up file: {cleanup_error}")


@router.post("/validate", response_model=ReceiptProcessResponse)
async def validate_corrected_receipt(
    corrected_data: ReceiptDataSchema,
    logger=Depends(get_logger_dependency)
):
    """
    Validate user-corrected receipt data.
    
    Use this after the user has corrected extraction errors.
    """
    try:
        logger.info("Validating user-corrected receipt data")
        
        # Convert schema to dict for validation
        from app.services.receipt_validator import receipt_validator_service
        
        data_dict = {
            "receipt_number": corrected_data.receipt_number,
            "date": corrected_data.date,
            "time": corrected_data.time,
            "store": {
                "name": corrected_data.store.name,
                "address": corrected_data.store.address,
                "phone": corrected_data.store.phone
            },
            "items": [
                {
                    "name": item.name,
                    "quantity": item.quantity,
                    "unit_price": item.unit_price,
                    "total_price": item.total_price
                }
                for item in corrected_data.items
            ],
            "subtotal": corrected_data.subtotal,
            "taxes_or_charges": [
                {
                    "name": tc.name,
                    "amount": tc.amount,
                    "percent": tc.percent
                }
                for tc in corrected_data.taxes_or_charges
            ],
            "grand_total": corrected_data.grand_total,
            "payment_method": corrected_data.payment_method,
            "transaction_id": corrected_data.transaction_id,
            "notes": corrected_data.notes
        }
        
        operation_id = f"validate_corrected_{hash(str(data_dict)) % 10000}"
        
        try:
            validated_data = receipt_validator_service.validate_and_process_receipt(
                data_dict, operation_id
            )
            
            # Convert back to schema
            from app.models.receipt import ReceiptData, StoreInfo, BillItem, TaxOrCharge
            
            receipt_model = ReceiptData(
                receipt_number=validated_data["receipt_number"],
                date=validated_data["date"],
                time=validated_data["time"],
                store=StoreInfo(**validated_data["store"]),
                items=[BillItem(**item) for item in validated_data["items"]],
                subtotal=validated_data["subtotal"],
                taxes_or_charges=[
                    TaxOrCharge(**tc) for tc in validated_data.get("taxes_or_charges", [])
                ],
                grand_total=validated_data["grand_total"],
                payment_method=validated_data.get("payment_method", "Unknown"),
                transaction_id=validated_data.get("transaction_id"),
                notes=validated_data.get("notes")
            )
            
            response_data = _convert_to_schema(receipt_model)
            
            logger.info("Corrected receipt validated successfully")
            return ReceiptProcessResponse(
                success=True,
                message="Receipt validated successfully",
                processed_data=response_data
            )
            
        except ValueError as e:
            error_msg = str(e)
            logger.warning(f"Corrected data validation failed: {error_msg}")
            
            raise HTTPException(
                status_code=422,
                detail={
                    "error": "Validation Failed",
                    "message": _format_user_friendly_error(error_msg),
                    "technical_details": error_msg,
                    "suggestions": [
                        "Double-check all item prices",
                        "Ensure items add up to the subtotal",
                        "Verify tax amounts are correct"
                    ]
                }
            )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error validating corrected receipt: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


def _convert_to_schema(receipt_data) -> ReceiptDataSchema:
    """Convert ReceiptData model to ReceiptDataSchema."""
    return ReceiptDataSchema(
        receipt_number=receipt_data.receipt_number,
        date=receipt_data.date,
        time=receipt_data.time,
        store=StoreInfoSchema(
            name=receipt_data.store.name,
            address=receipt_data.store.address,
            phone=receipt_data.store.phone
        ),
        items=[
            BillItemSchema(
                name=item.name,
                quantity=item.quantity,
                unit_price=item.unit_price,
                total_price=item.total_price
            )
            for item in receipt_data.items
        ],
        subtotal=receipt_data.subtotal,
        taxes_or_charges=[
            TaxOrChargeSchema(
                name=tc.name,
                amount=tc.amount,
                percent=tc.percent
            )
            for tc in receipt_data.taxes_or_charges
        ],
        grand_total=receipt_data.grand_total,
        payment_method=receipt_data.payment_method,
        transaction_id=receipt_data.transaction_id,
        notes=receipt_data.notes
    )


def _format_user_friendly_error(error_msg: str) -> str:
    """Convert technical error messages to user-friendly format."""
    if "Items total" in error_msg and "does not match" in error_msg:
        return (
            "The individual item prices don't add up to the subtotal shown on the receipt. "
            "Please review and correct the amounts."
        )
    if "Grand total validation failed" in error_msg:
        return (
            "The subtotal plus taxes doesn't equal the grand total. "
            "Please verify all amounts match the receipt."
        )
    if "Grand total is missing" in error_msg:
        return "Could not find the total amount on the receipt. Please enter it manually."
    
    return error_msg
